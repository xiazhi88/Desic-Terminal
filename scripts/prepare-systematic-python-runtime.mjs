import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(root, "src-tauri", "resources", "systematic-python");
const runtimeSource = process.env.DESIC_SYSTEMATIC_PYTHON_RUNTIME_DIR?.trim();
const targetPlatform = process.env.DESIC_SYSTEMATIC_PYTHON_TARGET_PLATFORM || process.platform;
const targetArch = process.env.DESIC_SYSTEMATIC_PYTHON_TARGET_ARCH || process.arch;
const sandboxProfile = process.env.DESIC_SYSTEMATIC_PYTHON_SANDBOX_PROFILE?.trim() || "bundled-cpython";
const skipDownload = process.env.DESIC_SYSTEMATIC_PYTHON_SKIP_DOWNLOAD === "1";
const MANIFEST_SCHEMA = "desic.systematic.python-runtime/v1";

// Pinned bundled CPython: python-build-standalone install_only_stripped,
// 3.11.16, release 20260814. The SHA-256 digests come from the official
// GitHub release and are the redistribution integrity boundary.
const BUNDLED = {
  version: "3.11.16",
  releaseTag: "20260814",
  targets: {
    "darwin|arm64": {
      triple: "aarch64-apple-darwin",
      sha256: "a394f2bf78a48990fc88e7c5586c7e1be5e69f0c9bd027883211b68b768e11c5"
    },
    "darwin|x64": {
      triple: "x86_64-apple-darwin",
      sha256: "4d60589b702aff21379ddf6bd648e75c7023a257a078fdd71df4c148cf609cc2"
    },
    "win32|x64": {
      triple: "x86_64-pc-windows-msvc",
      sha256: "c6de1a7781580d13f68dece33ac10b7a608c7ac21fc08cf0f4e0678a7d134905"
    }
  }
};

const cacheRoot = path.join(root, "cache", "systematic-python-runtime");
const requirementsPath = path.join(root, "scripts", "systematic", "python-runtime-requirements.txt");

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

async function isRegularFile(candidate) {
  try {
    const metadata = await lstat(candidate);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

async function sha256FileIfExists(candidate) {
  try {
    return sha256(await readFile(candidate));
  } catch {
    return null;
  }
}

async function resetOutput() {
  // The output directory also holds git-tracked strategy templates
  // (`templates/*.py`) that are product source, not build output. Clear only
  // the managed-runtime staging artifacts and keep those files; an earlier
  // unconditional `rm -rf` deleted the tracked templates on every build.
  const entries = await readdir(outputRoot).catch(() => []);
  for (const name of entries) {
    if (name === "templates" || name === ".gitkeep") continue;
    await rm(path.join(outputRoot, name), { recursive: true, force: true });
  }
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
  if (manifest.sandboxProfile !== sandboxProfile) {
    throw new Error(`runtime manifest sandboxProfile ${manifest.sandboxProfile} does not match the build sandbox profile ${sandboxProfile}`);
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
  const destination = safeJoin(outputRoot, entry.relativePath, "runtime output file");
  // Incremental staging: a destination that already matches the manifest
  // digest is left alone, so repeated builds only copy changed files.
  if (await isRegularFile(destination) && await sha256FileIfExists(destination) === entry.expectedSha256) {
    return;
  }
  const content = await readFile(source);
  const actualSha256 = sha256(content);
  if (actualSha256 !== entry.expectedSha256) {
    throw new Error(`runtime file checksum mismatch: ${entry.relativePath}`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  if (entry.executable && targetPlatform !== "win32") {
    const { chmod } = await import("node:fs/promises");
    await chmod(destination, 0o755);
  }
}

async function* walkFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      yield* walkFiles(full);
      continue;
    }
    if (entry.isFile()) yield full;
  }
}

async function writeManifestForTree(sourceRoot) {
  const pythonRelativePath = targetPlatform === "win32"
    ? "python/python.exe"
    : "python/bin/python3.11";
  if (!await isRegularFile(safeJoin(sourceRoot, pythonRelativePath, "bundled interpreter"))) {
    throw new Error(`bundled interpreter is missing from the artifact: ${pythonRelativePath}`);
  }
  const files = [];
  for await (const file of walkFiles(sourceRoot)) {
    const relative = path.relative(sourceRoot, file).split(path.sep).join("/");
    // The manifest itself is metadata, not a runtime file; a previous
    // generation would otherwise be hashed and then immediately overwritten.
    if (relative === "runtime-manifest.json") continue;
    files.push({
      path: relative,
      sha256: sha256(await readFile(file)),
      // macOS needs the interpreter and bin scripts executable; Windows has
      // no executable bit concept.
      executable: targetPlatform !== "win32" && relative.startsWith("python/bin/")
    });
  }
  const requirements = await readFile(requirementsPath, "utf8");
  const runtimeDependencies = requirements
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA,
    platform: targetPlatform,
    arch: targetArch,
    sandboxProfile,
    pythonRelativePath,
    files,
    runtimeDependencies,
    source: `python-build-standalone ${BUNDLED.version}+${BUNDLED.releaseTag} install_only_stripped`
  };
  await writeFile(path.join(sourceRoot, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function ensureBundledArtifact() {
  const pin = BUNDLED.targets[`${targetPlatform}|${targetArch}`];
  if (!pin) {
    throw new Error(`no bundled CPython runtime is pinned for ${targetPlatform}-${targetArch}`);
  }
  const fileName = `cpython-${BUNDLED.version}+${BUNDLED.releaseTag}-${pin.triple}-install_only_stripped.tar.gz`;
  await mkdir(cacheRoot, { recursive: true });
  const archive = path.join(cacheRoot, fileName);
  if (await sha256FileIfExists(archive) !== pin.sha256) {
    const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${BUNDLED.releaseTag}/${encodeURIComponent(fileName)}`;
    process.stdout.write(`[systematic-python] downloading ${fileName}\n`);
    let response;
    try {
      response = await fetch(url);
    } catch (error) {
      throw new Error(`could not download the bundled CPython runtime: ${error?.message || error}. Set DESIC_SYSTEMATIC_PYTHON_SKIP_DOWNLOAD=1 to build with the system-Python fallback instead.`);
    }
    if (!response.ok) {
      throw new Error(`bundled CPython download failed (HTTP ${response.status}): ${url}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const actual = sha256(buffer);
    if (actual !== pin.sha256) {
      throw new Error(`bundled CPython SHA-256 mismatch: expected ${pin.sha256}, got ${actual}`);
    }
    await writeFile(archive, buffer);
  }
  const extractDir = path.join(cacheRoot, `${BUNDLED.version}-${pin.triple}`);
  if (!await isRegularFile(path.join(extractDir, targetPlatform === "win32" ? "python/python.exe" : "python/bin/python3.11"))) {
    await rm(extractDir, { recursive: true, force: true });
    await mkdir(extractDir, { recursive: true });
    try {
      execFileSync("tar", ["-xzf", archive, "-C", extractDir], { stdio: "pipe" });
    } catch (error) {
      throw new Error(`could not extract the bundled CPython runtime: ${error?.message || error}`);
    }
  }
  await writeManifestForTree(extractDir);
  return extractDir;
}

async function main() {
  await resetOutput();
  let sourceRoot = null;
  if (runtimeSource) {
    sourceRoot = path.resolve(runtimeSource);
    const sourceMetadata = await lstat(sourceRoot);
    if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
      throw new Error("DESIC_SYSTEMATIC_PYTHON_RUNTIME_DIR must reference a regular runtime artifact directory");
    }
  } else if (skipDownload) {
    process.stdout.write("[systematic-python] bundled runtime download skipped; desktop local-Python research stays on the system-Python fallback\n");
    return;
  } else {
    sourceRoot = await ensureBundledArtifact();
  }
  const { manifest, files } = await readManifest(sourceRoot);
  for (const entry of files) await verifyAndCopy(sourceRoot, entry);
  await writeFile(path.join(outputRoot, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`[systematic-python] staged checksum-verified bundled CPython ${BUNDLED.version} for ${targetPlatform}-${targetArch}\n`);
}

main().catch((error) => {
  process.stderr.write(`[systematic-python] prepare failed: ${error?.stack || error}\n`);
  process.exit(1);
});
