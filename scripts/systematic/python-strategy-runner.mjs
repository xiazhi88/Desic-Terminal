import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_JSONL_MESSAGE_BYTES,
  PYTHON_STRATEGY_PROTOCOL,
  PythonStrategyProtocolError,
  parseProtocolLine,
  protocolErrorPayload,
  serializeProtocolLine,
  validateInvokeRequest,
  validateOutputForInvocation,
  validateStrategyParameters,
  validateStrategySource,
  verifyPinnedPythonRuntime
} from "./python-protocol.mjs";

const runtimeScriptPath = fileURLToPath(new URL("./python-strategy-runtime.py", import.meta.url));

function protocolFailure(code, message, details) {
  return new PythonStrategyProtocolError(code, message, details);
}

function assertAbsoluteFilePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw protocolFailure("invalid_launch_option", `${label} must be an absolute path`);
  }
}

function isolatedPythonEnvironment() {
  const environment = {
    PYTHONHASHSEED: "0",
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONSAFEPATH: "1",
    PYTHONUTF8: "1"
  };
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
      if (process.env[key]) environment[key] = process.env[key];
    }
  }
  return environment;
}

function messageError(message) {
  const error = new Error(message.message || "Python strategy runtime error");
  error.name = "PythonStrategyRuntimeError";
  error.code = message.code || "runtime_error";
  return error;
}

function handlerForEventKind(kind) {
  if (kind === "start") return "on_start";
  if (kind === "bar") return "on_bar";
  return "on_rebalance";
}

function isOptionalEventHandler(kind) {
  return kind === "start";
}

/**
 * Persistent JSONL process wrapper for a verified, application-bundled CPython runtime.
 * Callers must pass the path obtained from the release runtime manifest; this module never
 * searches for or installs a user Python interpreter.
 */
export class ManagedPythonStrategyRunner {
  #child;
  #cwd;
  #ready;
  #closed = false;
  #stdoutBuffer = "";
  #stderr = "";
  #pending = new Map();
  #requestTimeoutMs;
  #maxMessageBytes;
  #sourceInfo;
  #strategyStarted = false;
  #activeInvocation = false;
  #lastEventAsOfMs;

  constructor({
    pythonPath,
    expectedRuntimeSha256,
    runtimePath = runtimeScriptPath,
    requestTimeoutMs = 15_000,
    maxMessageBytes = MAX_JSONL_MESSAGE_BYTES
  }) {
    assertAbsoluteFilePath(pythonPath, "pythonPath");
    assertAbsoluteFilePath(runtimePath, "runtimePath");
    if (typeof expectedRuntimeSha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(expectedRuntimeSha256)) {
      throw protocolFailure("invalid_launch_option", "expectedRuntimeSha256 must be the approved 64-character SHA-256 runtime hash");
    }
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 300_000) {
      throw protocolFailure("invalid_launch_option", "requestTimeoutMs must be between 100 and 300000");
    }
    if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1_024 || maxMessageBytes > 16 * 1024 * 1024) {
      throw protocolFailure("invalid_launch_option", "maxMessageBytes must be between 1024 and 16777216");
    }
    this.pythonPath = pythonPath;
    this.expectedRuntimeSha256 = expectedRuntimeSha256;
    this.runtimePath = runtimePath;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#maxMessageBytes = maxMessageBytes;
  }

  get sourceInfo() {
    return this.#sourceInfo;
  }

  get running() {
    return Boolean(this.#child && !this.#closed && this.#child.exitCode === null);
  }

  async start() {
    if (this.running) return;
    if (this.#child) await this.close();
    await verifyPinnedPythonRuntime(this.pythonPath, this.expectedRuntimeSha256);
    this.#cwd = await mkdtemp(path.join(os.tmpdir(), "desic-systematic-python-"));
    this.#closed = false;
    this.#ready = this.#createReadyPromise();
    this.#child = spawn(this.pythonPath, ["-I", "-u", this.runtimePath], {
      cwd: this.#cwd,
      env: isolatedPythonEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    this.#child.stderr.on("data", (chunk) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-8_192);
    });
    this.#child.once("error", (error) => this.#terminate(error));
    this.#child.once("exit", (code, signal) => {
      if (!this.#closed) {
        this.#terminate(new Error(`Python strategy runtime exited unexpectedly (${code ?? "null"}${signal ? `, ${signal}` : ""})`));
      }
    });
    await this.#withTimeout(this.#ready, "Python strategy runtime readiness");
  }

  async load(source, params = {}) {
    const sourceInfo = validateStrategySource(source);
    const strategyParams = validateStrategyParameters(params);
    await this.start();
    if (this.#activeInvocation) {
      throw protocolFailure("runner_busy", "cannot load a strategy while an invocation is active");
    }
    this.#sourceInfo = undefined;
    this.#strategyStarted = false;
    this.#lastEventAsOfMs = undefined;
    try {
      const response = await this.#request("load", { source, params: strategyParams });
      if (
        !Array.isArray(response.handlers) ||
        response.handlers.length !== sourceInfo.handlers.length ||
        response.handlers.some((handler) => !sourceInfo.handlers.includes(handler))
      ) {
        throw protocolFailure("runtime_contract_error", "Python runtime returned unexpected strategy handlers");
      }
      this.#sourceInfo = sourceInfo;
      return { ...sourceInfo, handlers: response.handlers };
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async invoke(invocation) {
    await this.start();
    if (!this.#sourceInfo) throw protocolFailure("strategy_not_loaded", "load strategy source before invoking it");
    if (this.#activeInvocation) {
      throw protocolFailure("runner_busy", "dispatch strategy events serially; the previous invocation has not completed");
    }
    this.#activeInvocation = true;
    try {
      const request = validateInvokeRequest(invocation);
      if (this.#lastEventAsOfMs !== undefined && request.event.asOfMs < this.#lastEventAsOfMs) {
        throw protocolFailure("out_of_order_event", "strategy events must not move backward in time");
      }
      const handler = handlerForEventKind(request.event.kind);
      if (request.event.kind === "start" && this.#strategyStarted) {
        throw protocolFailure("invalid_lifecycle", "on_start may be invoked only once after each strategy load");
      }
      if (request.event.kind !== "start" && this.#sourceInfo.handlers.includes("on_start") && !this.#strategyStarted) {
        throw protocolFailure("invalid_lifecycle", "invoke on_start before dispatching bar or rebalance events");
      }
      if (!this.#sourceInfo.handlers.includes(handler)) {
        if (!isOptionalEventHandler(request.event.kind)) {
          throw protocolFailure("missing_handler", `strategy does not declare ${handler}(ctx)`);
        }
        const output = validateOutputForInvocation(
          { kind: "no_action", asOfMs: request.event.asOfMs, reason: `${handler} is not defined` },
          request
        );
        if (request.event.kind === "start") this.#strategyStarted = true;
        this.#lastEventAsOfMs = request.event.asOfMs;
        return output;
      }
      const response = await this.#request("invoke", { event: request.event }, request.requestId);
      const output = validateOutputForInvocation(response.output, request);
      if (request.event.kind === "start") this.#strategyStarted = true;
      this.#lastEventAsOfMs = request.event.asOfMs;
      return output;
    } finally {
      this.#activeInvocation = false;
    }
  }

  async close() {
    if (!this.#child) return;
    const child = this.#child;
    try {
      if (child.exitCode === null) {
        try {
          await this.#request("shutdown", {});
        } catch {
          // The process is still terminated below. Do not leave an active strategy runner behind.
        }
        child.stdin.end();
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 1_000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    } finally {
      this.#closed = true;
      if (child.exitCode === null) child.kill("SIGTERM");
      this.#rejectPending(protocolFailure("runner_closed", "Python strategy runner was closed"));
      this.#child = undefined;
      this.#sourceInfo = undefined;
      this.#strategyStarted = false;
      this.#activeInvocation = false;
      this.#lastEventAsOfMs = undefined;
      if (this.#cwd) await rm(this.#cwd, { recursive: true, force: true });
      this.#cwd = undefined;
    }
  }

  #createReadyPromise() {
    return new Promise((resolve, reject) => {
      this.#pending.set("__ready__", { resolve, reject, timer: undefined });
    });
  }

  #withTimeout(promise, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = protocolFailure("runtime_timeout", `${label} timed out after ${this.#requestTimeoutMs}ms`);
        this.#terminate(error);
        reject(error);
      }, this.#requestTimeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  #request(type, payload, requestId = randomUUID()) {
    if (!this.running) return Promise.reject(protocolFailure("runner_not_running", "Python strategy runner is not running"));
    const message = {
      protocol: PYTHON_STRATEGY_PROTOCOL,
      type,
      requestId,
      ...payload
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        const error = protocolFailure("runtime_timeout", `${type} request timed out after ${this.#requestTimeoutMs}ms`);
        this.#terminate(error);
        reject(error);
      }, this.#requestTimeoutMs);
      const expectedType = type === "load" ? "loaded" : type === "invoke" ? "result" : "shutdown";
      this.#pending.set(requestId, { resolve, reject, timer, expectedType });
      try {
        this.#child.stdin.write(serializeProtocolLine(message, { maxBytes: this.#maxMessageBytes }), "utf8");
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        reject(error);
      }
    });
  }

  #onStdout(chunk) {
    this.#stdoutBuffer += chunk;
    let newlineIndex;
    while ((newlineIndex = this.#stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.#stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        this.#onMessage(parseProtocolLine(line, { maxBytes: this.#maxMessageBytes }));
      } catch (error) {
        this.#terminate(error);
      }
    }
    if (Buffer.byteLength(this.#stdoutBuffer, "utf8") > this.#maxMessageBytes) {
      this.#terminate(protocolFailure("message_too_large", "Python strategy runtime emitted an oversized JSONL message"));
    }
  }

  #onMessage(message) {
    if (message?.protocol !== PYTHON_STRATEGY_PROTOCOL || typeof message.type !== "string") {
      throw protocolFailure("protocol_mismatch", "Python strategy runtime emitted an invalid protocol envelope");
    }
    if (message.type === "ready") {
      const pending = this.#pending.get("__ready__");
      if (pending) {
        this.#pending.delete("__ready__");
        pending.resolve(message);
      }
      return;
    }
    const requestId = message.requestId;
    if (typeof requestId !== "string") throw protocolFailure("protocol_mismatch", "Python runtime response has no requestId");
    const pending = this.#pending.get(requestId);
    if (!pending) throw protocolFailure("unexpected_response", `Python runtime returned an unknown requestId: ${requestId}`);
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    if (message.type === "error") {
      pending.reject(messageError(message));
      return;
    }
    if (message.type === pending.expectedType && message.requestId === requestId) {
      pending.resolve(message);
      return;
    }
    const error = protocolFailure("protocol_mismatch", `unexpected ${message.type} response for request ${requestId}`);
    pending.reject(error);
    this.#terminate(error);
  }

  #rejectPending(error) {
    for (const [requestId, pending] of this.#pending) {
      this.#pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  #terminate(error) {
    if (this.#closed) return;
    this.#closed = true;
    this.#sourceInfo = undefined;
    this.#strategyStarted = false;
    this.#activeInvocation = false;
    this.#lastEventAsOfMs = undefined;
    this.#rejectPending(error);
    if (this.#child?.exitCode === null) this.#child.kill("SIGTERM");
  }
}

export async function runPythonStrategy({ runner, source, params = {}, invocation }) {
  if (!(runner instanceof ManagedPythonStrategyRunner)) {
    throw protocolFailure("invalid_runner", "runner must be a ManagedPythonStrategyRunner");
  }
  try {
    await runner.load(source, params);
    return await runner.invoke(invocation);
  } catch (error) {
    const details = protocolErrorPayload(error);
    throw Object.assign(error instanceof Error ? error : new Error(details.message), { systematicProtocol: details });
  } finally {
    await runner.close();
  }
}
