import assert from "node:assert/strict";
import fs from "node:fs";

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const tauriConfig = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
const cargoToml = fs.readFileSync("src-tauri/Cargo.toml", "utf8");
const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const versions = [packageJson.version, tauriConfig.version, cargoVersion];

assert(versions.every(Boolean), "package, Tauri, and Cargo versions must all be present");
assert.equal(new Set(versions).size, 1, `version mismatch: package=${versions[0]}, tauri=${versions[1]}, cargo=${versions[2]}`);

const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : "";
if (tag) assert.equal(tag.replace(/^v/i, ""), versions[0], `release tag ${tag} does not match version ${versions[0]}`);

process.stdout.write(`[release] version ${versions[0]} is consistent${tag ? ` with ${tag}` : ""}\n`);
