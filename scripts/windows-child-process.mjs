import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const INSTALLED = Symbol.for("desic.windowsHiddenChildProcessPolicy");

function hiddenOptions(options) {
  return {
    ...(options && typeof options === "object" ? options : {}),
    windowsHide: true
  };
}

function call(method, args) {
  return Reflect.apply(method, childProcess, args);
}

export function installWindowsHiddenChildProcessPolicy(platform = process.platform) {
  if (platform !== "win32" || childProcess[INSTALLED]) return false;

  const original = {
    spawn: childProcess.spawn,
    spawnSync: childProcess.spawnSync,
    exec: childProcess.exec,
    execSync: childProcess.execSync,
    execFile: childProcess.execFile,
    execFileSync: childProcess.execFileSync,
    fork: childProcess.fork
  };

  childProcess.spawn = (command, args, options) => Array.isArray(args)
    ? call(original.spawn, [command, args, hiddenOptions(options)])
    : call(original.spawn, [command, hiddenOptions(args)]);

  childProcess.spawnSync = (command, args, options) => Array.isArray(args)
    ? call(original.spawnSync, [command, args, hiddenOptions(options)])
    : call(original.spawnSync, [command, hiddenOptions(args)]);

  childProcess.exec = (command, options, callback) => typeof options === "function"
    ? call(original.exec, [command, hiddenOptions(), options])
    : call(original.exec, [command, hiddenOptions(options), callback]);

  childProcess.execSync = (command, options) => call(original.execSync, [command, hiddenOptions(options)]);

  childProcess.execFile = (file, args, options, callback) => {
    if (Array.isArray(args)) {
      if (typeof options === "function") {
        return call(original.execFile, [file, args, hiddenOptions(), options]);
      }
      return call(original.execFile, [file, args, hiddenOptions(options), callback]);
    }
    const resolvedCallback = typeof args === "function" ? args : typeof options === "function" ? options : callback;
    const resolvedOptions = args && typeof args === "object" ? args : undefined;
    return call(original.execFile, [file, [], hiddenOptions(resolvedOptions), resolvedCallback]);
  };

  childProcess.execFileSync = (file, args, options) => Array.isArray(args)
    ? call(original.execFileSync, [file, args, hiddenOptions(options)])
    : call(original.execFileSync, [file, [], hiddenOptions(args)]);

  childProcess.fork = (modulePath, args, options) => Array.isArray(args)
    ? call(original.fork, [modulePath, args, hiddenOptions(options)])
    : call(original.fork, [modulePath, [], hiddenOptions(args)]);

  Object.defineProperty(childProcess, INSTALLED, { value: true });
  syncBuiltinESMExports();
  return true;
}
