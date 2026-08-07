import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(root, "src-tauri", "resources", "systematic-python");
const runtimeSource = process.env.DESIC_SYSTEMATIC_PYTHON_RUNTIME_DIR?.trim();
const targetPlatform = process.env.DESIC_SYSTEMATIC_PYTHON_TARGET_PLATFORM || process.platform;
const targetArch = process.env.DESIC_SYSTEMATIC_PYTHON_TARGET_ARCH || process.arch;
const sandboxProfile = process.env.DESIC_SYSTEMATIC_PYTHON_SANDBOX_PROFILE?.trim();
const MANIFEST_SCHEMA = "desic.systematic.python-runtime/v1";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function safeRelativePath(value, label) {
  const relative = requiredString(value, label);
  if (path.isAbsolute(relative) || relative.split(/[\\/]+/).includes("..")) {
    throw new Error(`${label} must be a relative path without parent traversal`);
  }
  return relative;
}

function safeJoin(rootPath, relativePath, label) {
  const candidate = path.resolve(rootPath, relativePath);
  if (candidate !== rootPath && !candidate.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error(`${label} escapes its runtime root`);
  }
  return candidate;
}

async function resetOutput() {
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(outputRoot, ".gitkeep"), "");
}

async function readManifest(sourceRoot) {
  const manifestPath = safeJoin(sourceRoot, "runtime-manifest.json", "runtime manifest");
  let raw;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    throw new Error(`cannot read runtime-manifest.json: ${error?.message || error}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new Error(`runtime-manifest.json is invalid JSON: ${error?.message || error}`);
  }
  if (manifest?.schemaVersion !== MANIFEST_SCHEMA) {
    throw new Error(`runtime manifest schemaVersion must be ${MANIFEST_SCHEMA}`);
  }
  if (manifest.platform !== targetPlatform || manifest.arch !== targetArch) {
    throw new Error(`runtime artifact ${manifest.platform}-${manifest.arch} does not match build target ${targetPlatform}-${targetArch}`);
  }
  if (!sandboxProfile || manifest.sandboxProfile !== sandboxProfile) {
    throw new Error("a matching DESIC_SYSTEMATIC_PYTHON_SANDBOX_PROFILE is required before a managed runtime can be staged");
  }
  const pythonRelativePath = safeRelativePath(manifest.pythonRelativePath, "pythonRelativePath");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("runtime manifest files must list every packaged runtime file");
  }
  if (!Array.isArray(manifest.runtimeDependencies)) {
    throw new Error("runtime manifest runtimeDependencies must document the bundled dependency set");
  }
  const seen = new Set();
  const files = manifest.files.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`files[${index}] must be an object`);
    const relativePath = safeRelativePath(entry.path, `files[${index}].path`);
    if (seen.has(relativePath)) throw new Error(`runtime manifest repeats ${relativePath}`);
    seen.add(relativePath);
    const expectedSha256 = requiredString(entry.sha256, `files[${index}].sha256`).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error(`files[${index}].sha256 must be a lowercase SHA-256 digest`);
    return { relativePath, expectedSha256, executable: entry.executable === true };
  });
  if (!seen.has(pythonRelativePath)) throw new Error("runtime manifest files must include pythonRelativePath");
  return { manifest, files };
}

async function verifyAndCopy(sourceRoot, entry) {
  const source = safeJoin(sourceRoot, entry.relativePath, "runtime file");
  const metadata = await lstat(source);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`runtime file ${entry.relativePath} must be a regular non-symlink file`);
  }
  const content = await readFile(source);
  const actualSha256 = sha256(content);
  if (actualSha256 !== entry.expectedSha256) {
    throw new Error(`runtime file checksum mismatch: ${entry.relativePath}`);
  }
  const destination = safeJoin(outputRoot, entry.relativePath, "runtime output file");
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  if (entry.executable && targetPlatform !== "win32") {
    const { chmod } = await import("node:fs/promises");
    await chmod(destination, 0o755);
  }
}

async function main() {
  await resetOutput();
  if (!runtimeSource) {
    process.stdout.write("[systematic-python] no managed runtime artifact configured; managed-runtime staging skipped (desktop local-Python research remains available)\n");
    return;
  }

  const sourceRoot = path.resolve(runtimeSource);
  const sourceMetadata = await lstat(sourceRoot);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new Error("DESIC_SYSTEMATIC_PYTHON_RUNTIME_DIR must reference a regular runtime artifact directory");
  }
  const { manifest, files } = await readManifest(sourceRoot);
  for (const entry of files) await verifyAndCopy(sourceRoot, entry);
  await writeFile(path.join(outputRoot, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`[systematic-python] staged checksum-verified runtime for ${targetPlatform}-${targetArch}\n`);
}

main().catch((error) => {
  process.stderr.write(`[systematic-python] prepare failed: ${error?.stack || error}\n`);
  process.exit(1);
});
