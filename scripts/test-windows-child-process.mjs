import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import {
  exec as namedExec,
  execFile as namedExecFile,
  fork as namedFork,
  spawn as namedSpawn,
  spawnSync as namedSpawnSync
} from "node:child_process";
import { installWindowsHiddenChildProcessPolicy } from "./windows-child-process.mjs";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const calls = [];

for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  childProcess[method] = (...args) => {
    calls.push({ method, args });
    return { method, args };
  };
}
syncBuiltinESMExports();

assert.equal(installWindowsHiddenChildProcessPolicy("linux"), false);
assert.equal(installWindowsHiddenChildProcessPolicy("win32"), true);
assert.equal(installWindowsHiddenChildProcessPolicy("win32"), false);

namedSpawn("tool", ["--version"], { windowsHide: false });
namedSpawnSync("tool", { cwd: "workspace" });
namedExec("tool --version", () => {});
namedExecFile("tool", ["--version"], { windowsHide: false }, () => {});
namedFork("worker.mjs", ["--child"], { silent: true });

assert.deepEqual(calls.map(({ method }) => method), ["spawn", "spawnSync", "exec", "execFile", "fork"]);
assert.equal(calls[0].args[2].windowsHide, true);
assert.equal(calls[1].args[1].windowsHide, true);
assert.equal(calls[2].args[1].windowsHide, true);
assert.equal(calls[3].args[2].windowsHide, true);
assert.equal(calls[4].args[2].windowsHide, true);
assert.equal(calls[1].args[1].cwd, "workspace");
assert.equal(calls[3].args[2].windowsHide, true);
assert.equal(calls[4].args[2].silent, true);

process.stdout.write("windows child-process policy tests passed\n");
