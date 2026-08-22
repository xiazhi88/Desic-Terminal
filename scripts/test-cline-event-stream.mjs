import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { aiRequestIdleTimeoutMs, bindConfiguredAgentToolEvent, buildSystemPrompt, createDesicTools, createProviderFetch, invalidToolArgumentsResult, isTransientAiNetworkError, loadClineSdk, mapCoreEvent, mapToolResult, prepareBackgroundOpportunityCommit, reduceAssistantTextLifecycle, rememberBackgroundOpportunityCommitResult, rememberDecisionContext, runProviderNetworkRetry, validateBackgroundOpportunityCommitInput, validateTradeOpportunityInput } from "./cline-sidecar.mjs";

const sessionId = "indicator-stream-test";
const wrap = (event) => ({
  type: "agent_event",
  payload: { sessionId, event }
});

const opportunityInput = {
  environment: "demo",
  instId: "BTC-USDT-SWAP",
  tdMode: "cross",
  intent: "open",
  direction: "short",
  size: "0.01",
  orderType: "limit",
  price: "65000",
  evidence: ["结构证据"],
  riskNotes: ["风险证据"],
  reason: "测试"
};
assert.deepEqual(validateTradeOpportunityInput(opportunityInput), { valid: true, issues: [] });
const zeroSizeValidation = validateTradeOpportunityInput({ ...opportunityInput, size: "0" });
assert.equal(zeroSizeValidation.valid, false);
assert.ok(zeroSizeValidation.issues.some((issue) => issue.includes("pattern")));
const missingLimitPrice = { ...opportunityInput };
delete missingLimitPrice.price;
const missingLimitPriceValidation = validateTradeOpportunityInput(missingLimitPrice);
assert.equal(missingLimitPriceValidation.valid, false);
assert.ok(missingLimitPriceValidation.issues.some((issue) => issue.includes("price")));
const decisionContextCorrection = invalidToolArgumentsResult("market.readDecisionContext", zeroSizeValidation.issues);
assert.match(decisionContextCorrection.correction, /wait\/abandon/);
assert.match(decisionContextCorrection.correction, /size=0/);
const malformedOpportunity = {
  ...opportunityInput,
  evidence: ["结构证据", ["错误嵌套的风险数组"]]
};
const malformedValidation = validateTradeOpportunityInput(malformedOpportunity);
assert.equal(malformedValidation.valid, false);
assert.ok(malformedValidation.issues.some((issue) => issue.includes("/evidence/1 必须是字符串")));
assert.deepEqual(
  invalidToolArgumentsResult("tradeOpportunity.create", malformedValidation.issues),
  {
    accepted: false,
    executed: false,
    retryable: true,
    errorCode: "invalid_tool_arguments",
    summary: "工具参数无效，未执行",
    errors: malformedValidation.issues,
    correction: "evidence 与 riskNotes 必须分别作为顶层字符串数组；close 必须提供 exitKind，止盈使用 take_profit+limit，止损使用 stop_loss+trigger；expiresAt、maxSlippageBps 等字段必须放在对象顶层。修正完整参数后重新调用 tradeOpportunity.create。"
  }
);

const workflow = { latestDecisionContext: null };
assert.deepEqual(validateBackgroundOpportunityCommitInput({}), { valid: true, issues: [] });
assert.equal(
  validateBackgroundOpportunityCommitInput({ decisionContextId: "model-invented-id" }).valid,
  false
);
assert.equal(
  validateBackgroundOpportunityCommitInput({ duplicateResolution: "reuse" }).valid,
  false
);
assert.equal(
  validateBackgroundOpportunityCommitInput({
    duplicateResolution: "create_new",
    duplicateResolutionReason: "当前候选具有不同的入场与失效条件"
  }).valid,
  true
);
assert.equal(
  validateBackgroundOpportunityCommitInput({
    relatedOpportunityId: "opp-existing",
    duplicateResolution: "reuse",
    duplicateResolutionReason: "复用已复核的原机会"
  }).valid,
  true
);
assert.equal(
  prepareBackgroundOpportunityCommit(workflow, {}).result.errorCode,
  "decision_context_required"
);
rememberDecisionContext(workflow, {
  decisionContextId: "decision-authoritative-id",
  expiresAt: 20_000,
  precheck: { blocked: false, reasons: [] }
});
assert.deepEqual(
  prepareBackgroundOpportunityCommit(workflow, {
    decisionContextId: "model-invented-id",
    duplicateResolution: "revise",
    duplicateResolutionReason: "更新重复机会"
  }, 10_000).input,
  {
    decisionContextId: "decision-authoritative-id",
    duplicateResolution: "revise",
    duplicateResolutionReason: "更新重复机会"
  }
);
assert.equal(
  prepareBackgroundOpportunityCommit(workflow, {}, 20_000).result.errorCode,
  "decision_context_expired"
);
rememberDecisionContext(workflow, {
  decisionContextId: "decision-blocked-id",
  expiresAt: 30_000,
  precheck: { blocked: true, reasons: ["保证金不足"] }
});
assert.deepEqual(
  prepareBackgroundOpportunityCommit(workflow, {}, 10_000).result,
  {
    accepted: false,
    executed: false,
    retryable: false,
    errorCode: "decision_context_blocked",
    summary: "最终复核预检已阻断，未创建交易机会",
    correction: "不要提交该候选；根据结构化 blockers 修改候选后重新复核，或正常调用 background.finishRun 结束本轮。",
    blockers: ["保证金不足"]
  }
);

const similarConflictWorkflow = {
  latestDecisionContext: {
    decisionContextId: "decision-similar-candidate",
    expiresAt: 30_000,
    blocked: false,
    blockers: []
  },
  latestOpportunityConflict: { kind: "similar", existingOpportunityId: "opp-existing" }
};
assert.equal(
  prepareBackgroundOpportunityCommit(similarConflictWorkflow, {
    relatedOpportunityId: "opp-existing",
    duplicateResolution: "reuse",
    duplicateResolutionReason: "复用已有机会"
  }, 10_000).result.errorCode,
  "duplicate_reuse_requires_exact_review"
);
rememberDecisionContext(similarConflictWorkflow, {
  decisionContextId: "decision-existing-exact",
  expiresAt: 40_000,
  precheck: { blocked: false, reasons: [] }
});
assert.equal(similarConflictWorkflow.latestOpportunityConflict, null);
assert.equal(
  prepareBackgroundOpportunityCommit(similarConflictWorkflow, {
    relatedOpportunityId: "opp-existing",
    duplicateResolution: "reuse",
    duplicateResolutionReason: "复用已复核的原机会"
  }, 10_000).input.decisionContextId,
  "decision-existing-exact"
);
const unresolvedConflictWorkflow = {
  latestDecisionContext: { decisionContextId: "decision-current" },
  latestOpportunityConflict: null
};
rememberBackgroundOpportunityCommitResult(unresolvedConflictWorkflow, {
  decisionContextId: "decision-current"
}, {
  id: "opp-existing",
  duplicateResolution: "create_new",
  conflict: { kind: "exact", existingOpportunityId: "opp-existing" }
});
assert.equal(
  unresolvedConflictWorkflow.latestDecisionContext.decisionContextId,
  "decision-current"
);
assert.equal(unresolvedConflictWorkflow.latestOpportunityConflict.kind, "exact");
rememberBackgroundOpportunityCommitResult(unresolvedConflictWorkflow, {
  decisionContextId: "decision-current",
  duplicateResolution: "reuse"
}, {
  id: "opp-existing",
  duplicateResolution: "reuse",
  conflict: { kind: "exact", existingOpportunityId: "opp-existing" }
});
assert.equal(unresolvedConflictWorkflow.latestDecisionContext, null);
assert.equal(unresolvedConflictWorkflow.latestOpportunityConflict, null);

assert.deepEqual(
  mapCoreEvent(sessionId, wrap({ type: "content_start", contentType: "reasoning", reasoning: "分析结构" })),
  { type: "delta", sessionId, channel: "reasoning", content: "分析结构" }
);

assert.deepEqual(
  mapCoreEvent(sessionId, wrap({
    type: "assistant-reasoning-delta",
    text: "Inspecting inputs",
    metadata: {
      provider: "codex-app-server",
      itemId: "reasoning-1",
      isSummary: true
    }
  })),
  {
    type: "delta",
    sessionId,
    channel: "reasoning",
    content: "Inspecting inputs",
    reasoningId: "reasoning-1",
    reasoningSummary: true
  }
);

assert.deepEqual(
  mapCoreEvent(sessionId, wrap({ type: "content_start", contentType: "text", text: "准备生成指标", accumulated: "准备生成指标" })),
  {
    type: "turnText",
    sessionId,
    mode: "delta",
    content: "准备生成指标",
    accumulated: "准备生成指标",
    source: "content_start"
  }
);

const mappedToolCall = mapCoreEvent(sessionId, wrap({
    type: "content_start",
    contentType: "tool",
    toolName: "script.createOrUpdate",
    toolCallId: "tool-1",
    input: { name: "测试指标" }
  }));
assert.equal(typeof mappedToolCall?.startedAt, "number");
assert.deepEqual(
  { ...mappedToolCall, startedAt: undefined },
  {
    type: "toolCall",
    sessionId,
    toolCallId: "tool-1",
    name: "script.createOrUpdate",
    arguments: { name: "测试指标" },
    agentId: undefined,
    parentAgentId: undefined,
    startedAt: undefined
  }
);

assert.deepEqual(
  mapCoreEvent(sessionId, wrap({ type: "content_end", contentType: "text", text: "指标已生成" })),
  { type: "turnText", sessionId, mode: "snapshot", content: "指标已生成", source: "content_end" }
);

assert.deepEqual(
  mapCoreEvent(sessionId, wrap({ type: "iteration_end", iteration: 1, hadToolCalls: true, toolCallCount: 1 })),
  { type: "iterationEnd", sessionId, iteration: 1, hadToolCalls: true, toolCallCount: 1 }
);

assert.deepEqual(
  mapCoreEvent(sessionId, wrap({ type: "done", reason: "completed", text: "最终回答", iterations: 2 })),
  { type: "finalText", sessionId, content: "最终回答", finishReason: "completed", source: "agent-done" }
);

const legacyUsage = mapCoreEvent(sessionId, wrap({
  type: "usage",
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 40,
  cacheWriteTokens: 5,
  totalInputTokens: 300,
  totalOutputTokens: 50,
  totalCacheReadTokens: 100,
  totalCacheWriteTokens: 5
}));
assert.equal(legacyUsage?.usage?.usageKind, "delta-with-totals");
assert.equal(legacyUsage?.usage?.inputTokens, 100);
assert.equal(legacyUsage?.usage?.totalInputTokens, 300);
assert.equal(legacyUsage?.usage?.totalCacheReadTokens, 100);
assert.equal(legacyUsage?.usage?.totalCacheWriteTokens, 5);

const cumulativeUsage = mapCoreEvent(sessionId, {
  type: "usage-updated",
  usage: { inputTokens: 300, outputTokens: 50, cacheReadTokens: 100 }
});
assert.equal(cumulativeUsage?.usage?.usageKind, "cumulative");
assert.equal(cumulativeUsage?.usage?.inputTokens, 300);
assert.equal(cumulativeUsage?.usage?.cacheReadTokens, 100);

const stableToolCallId = "call-stable-ticker";
assert.equal(
  mapCoreEvent(sessionId, {
    type: "tool-started",
    toolCall: {
      id: "tool-start-event",
      toolCallId: stableToolCallId,
      toolName: "market.readTicker",
      input: { instId: "BTC-USDT-SWAP" }
    }
  })?.toolCallId,
  stableToolCallId
);
const stableToolResult = mapCoreEvent(sessionId, {
  type: "tool-finished",
  toolCall: {
    id: "tool-finish-event",
    toolCallId: stableToolCallId,
    toolName: "market.readTicker",
    output: { summary: "BTC 行情已读取" }
  }
});
assert.equal(stableToolResult?.toolCallId, stableToolCallId);
assert.equal(stableToolResult?.summary, "BTC 行情已读取");
assert.equal(typeof stableToolResult?.endedAt, "number");
const timedToolResult = mapToolResult(
  sessionId,
  { toolCallId: "timed-tool", toolName: "market.readCandles" },
  {
    summary: "K 线已读取",
    candles: [],
    _toolTiming: {
      requestedAt: 1_000,
      executionStartedAt: 2_500,
      executionEndedAt: 2_540
    }
  }
);
assert.equal(timedToolResult.requestedAt, 1_000);
assert.equal(timedToolResult.executionStartedAt, 2_500);
assert.equal(timedToolResult.executionEndedAt, 2_540);
assert.equal(timedToolResult.result._toolTiming, undefined);
assert.deepEqual(timedToolResult.result.candles, []);
assert.deepEqual(
  bindConfiguredAgentToolEvent(stableToolResult, { configuredAgentId: "market-structure" }),
  {
    ...stableToolResult,
    agentId: "market-structure",
    configuredAgentId: "market-structure"
  }
);
assert.equal(bindConfiguredAgentToolEvent(stableToolResult, {}).agentId, undefined);

for (const message of [
  "getaddrinfo ENOTFOUND api.deepseek.com",
  "getaddrinfo EAI_AGAIN api.deepseek.com",
  "Connect Timeout Error (UND_ERR_CONNECT_TIMEOUT)",
  "fetch failed: socket hang up",
  "Cannot connect to API: other side closed: SocketError: other side closed (UND_ERR_SOCKET)",
  "HTTP 429 rate limit"
]) {
  assert.equal(isTransientAiNetworkError(message), true, message);
}
assert.equal(isTransientAiNetworkError("HTTP 401 invalid API key"), false);
assert.equal(isTransientAiNetworkError("HTTP 429 insufficient_quota"), false);
assert.equal(aiRequestIdleTimeoutMs({ provider: "openai-codex-cli" }), null);
assert.equal(aiRequestIdleTimeoutMs({ provider: "claude-code" }), null);
assert.equal(aiRequestIdleTimeoutMs({ provider: "openai-native" }), 60_000);
assert.equal(aiRequestIdleTimeoutMs({ provider: "openai-codex-cli", requestTimeoutMs: 500 }), 500);

const localCliSilentState = {
  abortController: new AbortController(),
  cancelled: false,
  hasProviderProgress: true,
  retryableNetworkError: "",
  providerErrorReject: null,
  abortRequested: false,
  lastProviderActivityAt: 0
};
let localCliAbortCount = 0;
const localCliSilentResult = await runProviderNetworkRetry({
  sessionId,
  state: localCliSilentState,
  operation: () => new Promise((resolve) => {
    setTimeout(() => resolve({ finishReason: "completed", text: "CLI response after silence" }), 40);
  }),
  abort: async () => { localCliAbortCount += 1; },
  timeoutMs: aiRequestIdleTimeoutMs({ provider: "openai-codex-cli" })
});
assert.equal(localCliSilentResult.finishReason, "completed");
assert.equal(localCliAbortCount, 0);

let providerAbortCount = 0;
const providerErrorState = {
  abortController: new AbortController(),
  cancelled: false,
  hasProviderProgress: true,
  retryableNetworkError: "",
  providerErrorReject: null
};
const providerErrorStartedAt = Date.now();
const immediateProviderError = await runProviderNetworkRetry({
  sessionId,
  state: providerErrorState,
  operation: () => {
    queueMicrotask(() => providerErrorState.providerErrorReject?.(new Error("Request timed out.")));
    return new Promise(() => {});
  },
  abort: async () => { providerAbortCount += 1; },
  timeoutMs: 5_000
});
assert.equal(immediateProviderError.finishReason, "error");
assert.equal(immediateProviderError.errorMessage, "Request timed out.");
assert.equal(providerAbortCount, 1);
assert.ok(Date.now() - providerErrorStartedAt < 1_000, "provider error should fail before the idle timeout");
const activeStreamState = {
  abortController: new AbortController(),
  cancelled: false,
  hasProviderProgress: false,
  retryableNetworkError: "",
  providerErrorReject: null,
  abortRequested: false,
  lastProviderActivityAt: 0
};
const activeStreamStartedAt = Date.now();
const activeStreamResult = await runProviderNetworkRetry({
  sessionId,
  state: activeStreamState,
  operation: () => new Promise((resolve) => {
    const activity = setInterval(() => {
      activeStreamState.lastProviderActivityAt = Date.now();
    }, 5);
    setTimeout(() => {
      clearInterval(activity);
      resolve({ finishReason: "completed", text: "long stream completed" });
    }, 75);
  }),
  abort: async () => {},
  timeoutMs: 20
});
assert.equal(activeStreamResult.finishReason, "completed");
assert.ok(Date.now() - activeStreamStartedAt >= 60, "provider activity should extend the idle timeout beyond total duration");
const observed503State = {
  abortController: new AbortController(),
  cancelled: false,
  hasProviderProgress: false,
  retryableNetworkError: 'error (503): {"message":"Service temporarily unavailable","type":"api_error"}',
  providerErrorReject: null,
  abortRequested: false
};
const observed503Result = await runProviderNetworkRetry({
  sessionId,
  state: observed503State,
  operation: () => new Promise(() => {}),
  abort: async () => {},
  timeoutMs: 10
});
assert.equal(observed503Result.errorMessage, observed503State.retryableNetworkError);
let failedStatusAttempts = 0;
let failedStatusAborts = 0;
const failedStatusRetry = await runProviderNetworkRetry({
  sessionId,
  state: {
    abortController: new AbortController(),
    cancelled: false,
    hasProviderProgress: false,
    retryableNetworkError: "",
    providerErrorReject: null,
    abortRequested: false
  },
  operation: async () => {
    failedStatusAttempts += 1;
    if (failedStatusAttempts === 1) {
      return { result: { status: "failed", errorMessage: "Reconnecting... 1/5 (unexpected status 503 Service Unavailable)" } };
    }
    return { result: { status: "completed", text: "ok" } };
  },
  abort: async () => { failedStatusAborts += 1; },
  timeoutMs: 5_000
});
assert.equal(failedStatusRetry.result.status, "completed");
assert.equal(failedStatusAttempts, 2);
assert.equal(failedStatusAborts, 1);

const textState = {
  pendingTurnText: "",
  iterationReasoningStreamed: false,
  finalTextEmitted: false
};
assert.deepEqual(
  reduceAssistantTextLifecycle(textState, { type: "turnText", mode: "delta", content: "先检查账户。" }),
  { handled: true, outputs: [{ channel: "text-preview", content: "先检查账户。" }] }
);
assert.deepEqual(
  reduceAssistantTextLifecycle(textState, { type: "toolCall", name: "market.readAccount" }),
  {
    handled: false,
    outputs: [
      { channel: "text-preview-clear", content: "clear" },
      { channel: "text", content: "先检查账户。" }
    ]
  }
);
assert.deepEqual(
  reduceAssistantTextLifecycle(textState, { type: "turnText", mode: "snapshot", content: "这是最终回答。" }),
  { handled: true, outputs: [{ channel: "text-preview", content: "这是最终回答。" }] }
);
assert.deepEqual(
  reduceAssistantTextLifecycle(textState, { type: "iterationEnd", hadToolCalls: false }),
  { handled: true, outputs: [] }
);
assert.deepEqual(
  reduceAssistantTextLifecycle(textState, { type: "finalText", content: "这是最终回答。" }),
  { handled: true, outputs: [{ channel: "text-final", content: "这是最终回答。" }] }
);
assert.deepEqual(
  reduceAssistantTextLifecycle(textState, { type: "finalText", content: "不应重复发出" }),
  { handled: true, outputs: [] }
);

const capturedClaudeRequests = [];
const captureFetch = async (input, init) => {
  capturedClaudeRequests.push({ input, init });
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};
const sonnetFetch = createProviderFetch({ provider: "anthropic", model: "claude-sonnet-5" }, "medium", captureFetch);
assert.equal(typeof sonnetFetch, "function");
await sonnetFetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  body: JSON.stringify({
    model: "claude-sonnet-5",
    thinking: { type: "enabled", budget_tokens: 1024 },
    temperature: 0.7
  })
});
const adaptedSonnetBody = JSON.parse(capturedClaudeRequests.at(-1).init.body);
assert.deepEqual(adaptedSonnetBody.thinking, { type: "adaptive" });
assert.deepEqual(adaptedSonnetBody.output_config, { effort: "medium" });
assert.equal(adaptedSonnetBody.temperature, undefined);

const opusNoThinkingFetch = createProviderFetch({ provider: "anthropic", model: "claude-opus-5" }, "none", captureFetch);
await opusNoThinkingFetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  body: JSON.stringify({ model: "claude-opus-5", thinking: { type: "enabled", budget_tokens: 1024 } })
});
const adaptedOpusBody = JSON.parse(capturedClaudeRequests.at(-1).init.body);
assert.deepEqual(adaptedOpusBody.thinking, { type: "disabled" });
assert.equal(adaptedOpusBody.output_config, undefined);

const fableLowFetch = createProviderFetch({ provider: "anthropic", model: "claude-fable-5" }, "none", captureFetch);
await fableLowFetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  body: JSON.stringify({ model: "claude-fable-5", thinking: { type: "enabled", budget_tokens: 1024 } })
});
const adaptedFableBody = JSON.parse(capturedClaudeRequests.at(-1).init.body);
assert.deepEqual(adaptedFableBody.thinking, { type: "adaptive" });
assert.deepEqual(adaptedFableBody.output_config, { effort: "low" });

const grokFetch = createProviderFetch({ provider: "xai", model: "grok-4.5" }, "xhigh", captureFetch);
await grokFetch("https://api.x.ai/v1/chat/completions", {
  method: "POST",
  body: JSON.stringify({ model: "grok-4.5", thinking: { type: "adaptive" }, reasoning_effort: "high" })
});
const adaptedGrokBody = JSON.parse(capturedClaudeRequests.at(-1).init.body);
assert.equal(adaptedGrokBody.thinking, undefined);
assert.equal(adaptedGrokBody.reasoning_effort, "high");

// A Claude model exposing xhigh keeps it; one that does not falls back to "max".
const claudeXhighFetch = createProviderFetch({ provider: "anthropic", model: "claude-opus-5" }, "xhigh", captureFetch);
await claudeXhighFetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  body: JSON.stringify({ model: "claude-opus-5" })
});
assert.equal(JSON.parse(capturedClaudeRequests.at(-1).init.body).output_config.effort, "xhigh");
const claudeXhighMaxFetch = createProviderFetch({ provider: "anthropic", model: "claude-sonnet-4-6" }, "xhigh", captureFetch);
await claudeXhighMaxFetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  body: JSON.stringify({ model: "claude-sonnet-4-6" })
});
assert.equal(JSON.parse(capturedClaudeRequests.at(-1).init.body).output_config.effort, "max");

const kimiFetch = createProviderFetch({ provider: "moonshot", model: "kimi-k2.6" }, "medium", captureFetch);
await kimiFetch("https://api.moonshot.cn/v1/chat/completions", {
  method: "POST",
  body: JSON.stringify({
    model: "kimi-k2.6",
    thinking: { type: "adaptive" },
    reasoning_effort: "medium",
    temperature: 0.7,
    top_p: 0.9
  })
});
const adaptedKimiBody = JSON.parse(capturedClaudeRequests.at(-1).init.body);
assert.deepEqual(adaptedKimiBody.thinking, { type: "enabled" });
assert.equal(adaptedKimiBody.reasoning_effort, undefined);
assert.equal(adaptedKimiBody.temperature, undefined);
assert.equal(adaptedKimiBody.top_p, undefined);

const doubaoFetch = createProviderFetch({ provider: "doubao", model: "doubao-seed-2-0-pro-260215" }, "medium", captureFetch);
await doubaoFetch("https://ark.cn-beijing.volces.com/api/v3/chat/completions", {
  method: "POST",
  body: JSON.stringify({ model: "doubao-seed-2-0-pro-260215", thinking: { type: "adaptive" } })
});
const adaptedDoubaoBody = JSON.parse(capturedClaudeRequests.at(-1).init.body);
assert.equal(adaptedDoubaoBody.thinking, undefined);
const proxiedOpenAiFetch = createProviderFetch({
  provider: "openai-native",
  model: "gpt-test",
  baseUrl: "http://gateway.example/v1"
}, "medium", captureFetch);
await proxiedOpenAiFetch("http://gateway.example/v1/responses", {
  method: "POST",
  body: JSON.stringify({ model: "gpt-test", input: "hello", truncation: "auto" })
});
const proxiedOpenAiBody = JSON.parse(capturedClaudeRequests.at(-1).init.body);
assert.equal(proxiedOpenAiBody.truncation, undefined);

const officialOpenAiFetch = createProviderFetch({
  provider: "openai-native",
  model: "gpt-test",
  baseUrl: "https://api.openai.com/v1"
}, "medium", captureFetch);
await officialOpenAiFetch("https://api.openai.com/v1/responses", {
  method: "POST",
  body: JSON.stringify({ model: "gpt-test", input: "hello", truncation: "auto" })
});
const officialOpenAiBody = JSON.parse(capturedClaudeRequests.at(-1).init.body);
assert.equal(officialOpenAiBody.truncation, "auto");

const failingProviderFetch = createProviderFetch({ provider: "openai-native", model: "gpt-test" }, "medium", async () => new Response(
  JSON.stringify({ message: "Service temporarily unavailable", type: "api_error" }),
  { status: 503, headers: { "content-type": "application/json" } }
));
await assert.rejects(
  () => failingProviderFetch("https://gateway.invalid/v1/responses", { method: "POST" }),
  (error) => {
    assert.equal(error.name, "ProviderHttpError");
    assert.equal(error.status, 503);
    assert.equal(error.message, 'error (503): {"message":"Service temporarily unavailable","type":"api_error"}');
    assert.equal(isTransientAiNetworkError(error), false);
    return true;
  }
);

await loadClineSdk();
const modelFacingPrompt = buildSystemPrompt({
  backgroundRun: true,
  reviewRun: true,
  skillDefinitions: [{
    id: "desic-core-operations",
    content: "最终调用 background.finishRun；必要时先调用 market.readDecisionContext。"
  }]
}, "copilot");
assert.match(modelFacingPrompt, /background_finishRun/);
assert.match(modelFacingPrompt, /market_readDecisionContext/);
assert.doesNotMatch(modelFacingPrompt, /background\.finishRun/);
assert.doesNotMatch(modelFacingPrompt, /market\.readDecisionContext/);
const retryableCompletionTools = createDesicTools("completion-tool-test", {
  permissionMode: "copilot",
  backgroundRun: true,
  reviewRun: true,
  toolAllowlist: ["background.finishRun", "review.complete"]
});
for (const canonicalName of ["background.finishRun", "review.complete"]) {
  const providerName = canonicalName.replaceAll(".", "_");
  const completionTool = retryableCompletionTools.find((tool) => tool.name === providerName);
  assert.ok(completionTool, `${canonicalName} should be registered`);
  assert.match(completionTool.description, new RegExp(`Callable tool name: ${providerName}`));
  assert.ok(!completionTool.description.includes(canonicalName));
  assert.notEqual(
    completionTool.lifecycle?.completesRun,
    true,
    `${canonicalName} must allow a rejected invocation to return correction feedback and retry`
  );
}

const decisionContextTool = createDesicTools("model-facing-result-test", {
  permissionMode: "copilot",
  backgroundRun: true,
  toolAllowlist: ["market.readDecisionContext"]
}).find((tool) => tool.name === "market_readDecisionContext");
assert.ok(decisionContextTool);
const modelFacingCorrection = await decisionContextTool.execute({
  candidate: { ...opportunityInput, size: "0" }
});
assert.match(modelFacingCorrection.correction, /background_finishRun/);
assert.doesNotMatch(modelFacingCorrection.correction, /background\.finishRun/);

const resumeHome = await mkdtemp(join(tmpdir(), "desic-cline-resume-"));
try {
  const restartContract = `
    import assert from "node:assert/strict";
    import { mkdtemp } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { ClineCore } from "@cline/sdk";

    const cwd = await mkdtemp(join(tmpdir(), "desic-cline-resume-workspace-"));
    const config = {
      sessionId: "resume-contract-test",
      providerId: "openai-compatible",
      modelId: "test-model",
      apiKey: "placeholder",
      cwd,
      workspaceRoot: cwd,
      mode: "plan",
      enableTools: false,
      enableSpawnAgent: false,
      enableAgentTeams: false,
      disableMcpSettingsTools: true,
      systemPrompt: "test"
    };
    const messages = [{
      role: "user",
      content: [{ type: "text", text: "remember this context" }],
      ts: Date.now()
    }];
    const first = await ClineCore.create({ clientName: "Desic session test", backendMode: "local" });
    await first.start({ config, interactive: true, initialMessages: messages });
    await first.dispose();

    const second = await ClineCore.create({ clientName: "Desic session test", backendMode: "local" });
    const persisted = await second.readMessages(config.sessionId);
    assert.equal(persisted.length, 1);
    await second.start({ config, interactive: true, initialMessages: persisted });
    const rehydrated = await second.readMessages(config.sessionId);
    assert.equal(rehydrated.length, 1);
    await second.dispose();
    console.log("cline restart hydration contract passed");
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", restartContract], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: resumeHome },
    encoding: "utf8",
    timeout: 30_000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /cline restart hydration contract passed/);
} finally {
  await rm(resumeHome, { recursive: true, force: true });
}

console.log("cline nested agent_event streaming mapper passed");
