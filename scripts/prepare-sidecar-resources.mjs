import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outputRoot = path.join(root, "src-tauri", "resources", "ai-sidecar");
const runtimeDir = path.join(outputRoot, "runtime");
const cacheRoot = path.join(os.homedir(), ".cache", "desictrade-build", "node");
const nodeVersion = process.env.DESIC_SIDECAR_NODE_VERSION || "22.23.1";
const targetPlatform = process.env.DESIC_SIDECAR_TARGET_PLATFORM || process.platform;
const targetArch = process.env.DESIC_SIDECAR_TARGET_ARCH || process.arch;
const officialNodeDist = "https://nodejs.org/dist";
const nodeDistBases = [
  process.env.DESIC_NODE_DIST_BASE,
  "https://npmmirror.com/mirrors/node",
  officialNodeDist
].filter(Boolean);

function platformArchive() {
  if (!["arm64", "x64"].includes(targetArch)) {
    throw new Error(`unsupported sidecar architecture: ${targetArch}`);
  }
  if (targetPlatform === "darwin") {
    return {
      fileName: `node-v${nodeVersion}-darwin-${targetArch}.tar.gz`,
      nodeRelativePath: path.join(`node-v${nodeVersion}-darwin-${targetArch}`, "bin", "node"),
      outputName: "node"
    };
  }
  if (targetPlatform === "win32") {
    return {
      fileName: `node-v${nodeVersion}-win-${targetArch}.zip`,
      nodeRelativePath: path.join(`node-v${nodeVersion}-win-${targetArch}`, "node.exe"),
      outputName: "node.exe"
    };
  }
  throw new Error(`unsupported sidecar platform: ${targetPlatform}`);
}

async function download(url, destination) {
  const temporary = `${destination}.download`;
  await rm(temporary, { force: true });
  try {
    await execFileAsync("curl", [
      "--fail",
      "--location",
      "--retry", "3",
      "--retry-all-errors",
      "--connect-timeout", "20",
      "--max-time", "600",
      "--http1.1",
      "--silent",
      "--show-error",
      "--output", temporary,
      url
    ], { maxBuffer: 4 * 1024 * 1024 });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function downloadFromDist(fileName, destination, bases = nodeDistBases) {
  const failures = [];
  for (const base of bases) {
    const url = `${base.replace(/\/$/, "")}/v${nodeVersion}/${fileName}`;
    try {
      await download(url, destination);
      return;
    } catch (error) {
      failures.push(`${url}: ${error?.message || error}`);
    }
  }
  throw new Error(`all Node.js download sources failed:\n${failures.join("\n")}`);
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function ensureNodeRuntime() {
  const archive = platformArchive();
  const versionRoot = path.join(cacheRoot, nodeVersion, `${targetPlatform}-${targetArch}`);
  const archivePath = path.join(versionRoot, archive.fileName);
  const extractedNode = path.join(versionRoot, "extracted", archive.nodeRelativePath);
  await mkdir(versionRoot, { recursive: true });

  const shasumsPath = path.join(versionRoot, "SHASUMS256.txt");
  if (!(await exists(shasumsPath))) {
    const checksumBases = [officialNodeDist, ...nodeDistBases.filter((base) => base !== officialNodeDist)];
    await downloadFromDist("SHASUMS256.txt", shasumsPath, checksumBases);
  }
  const expected = (await readFile(shasumsPath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find(([, fileName]) => fileName === archive.fileName)?.[0];
  if (!expected) throw new Error(`Node.js checksum is missing for ${archive.fileName}`);

  if (!(await exists(archivePath)) || (await sha256(archivePath)) !== expected) {
    await rm(archivePath, { force: true });
    await downloadFromDist(archive.fileName, archivePath);
  }
  const actual = await sha256(archivePath);
  if (actual !== expected) throw new Error(`Node.js checksum mismatch for ${archive.fileName}`);

  if (!(await exists(extractedNode))) {
    const extractRoot = path.join(versionRoot, "extracted");
    await rm(extractRoot, { recursive: true, force: true });
    await mkdir(extractRoot, { recursive: true });
    await execFileAsync("tar", ["-xf", archivePath, "-C", extractRoot]);
  }
  return { source: extractedNode, outputName: archive.outputName };
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const runtime = await ensureNodeRuntime();
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(path.join(outputRoot, ".gitkeep"), "");

  const { build } = await import("esbuild");
  await build({
    entryPoints: [path.join(root, "scripts", "cline-sidecar.mjs")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: path.join(outputRoot, "sidecar.mjs"),
    banner: {
      js: 'import { createRequire as __desicCreateRequire } from "node:module"; const require = __desicCreateRequire(import.meta.url);'
    },
    logLevel: "warning"
  });

  const nodeOutput = path.join(runtimeDir, runtime.outputName);
  await copyFile(runtime.source, nodeOutput);
  if (targetPlatform !== "win32") await chmod(nodeOutput, 0o755);
  await writeFile(path.join(outputRoot, "manifest.json"), `${JSON.stringify({ nodeVersion, platform: targetPlatform, arch: targetArch }, null, 2)}\n`);
  process.stdout.write(`[sidecar] prepared Node ${nodeVersion} for ${targetPlatform}-${targetArch}\n`);
}

main().catch((error) => {
  process.stderr.write(`[sidecar] prepare failed: ${error?.stack || error}\n`);
  process.exit(1);
});
