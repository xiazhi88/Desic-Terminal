# Skill Platform

Desic Skills are portable instruction bundles. A plain `SKILL.md` remains compatible with Cline and Codex-style tooling. A bundle can optionally add resources and a narrow, host-controlled executable runtime.

## Bundle layout

```text
SKILL.md
desic-skill.json
references/
assets/
scripts/
```

`SKILL.md` is required and UTF-8. `desic-skill.json` is optional. The import process rejects symlinks, hidden checkout metadata, traversal paths, duplicate paths, oversized files, and `node_modules`.

Every imported bundle is copied to an immutable local store:

```text
<app workspace>/skills/bundles/<skill-id>/<bundle-hash>/
```

The bundle hash is calculated from normalized relative paths, file sizes, and SHA-256 file hashes. Editing a bundle-backed Skill creates a new immutable snapshot and preserves every non-`SKILL.md` resource. Old versioned Runs retain their own private materialized copies.

## Runtime manifest

`desic-skill.json` uses camel-case JSON:

```json
{
  "schemaVersion": 1,
  "capabilities": {
    "network": false,
    "workspaceWrite": false
  },
  "runtime": {
    "kind": "node",
    "dependencyMode": "locked",
    "dependencies": {
      "manager": "npm",
      "packageJson": "package.json",
      "lockFile": "package-lock.json"
    },
    "entrypoints": [
      {
        "name": "normalize",
        "script": "scripts/normalize.mjs",
        "timeoutSeconds": 30,
        "inputSchema": { "type": "object" },
        "outputSchema": { "type": "object" }
      }
    ]
  }
}
```

Only named entrypoints are executable. Raw command strings are never accepted. Entrypoints must be under `scripts/`; their timeout is limited to 1 through 900 seconds. `inputSchema` and `outputSchema` are JSON objects. The host accepts only JSON-object input and validates declared basic object, array, scalar, enum, required-field, property, and item constraints before returning JSON output.

Current runtime kinds are `node` and `python`. A `shell` declaration is parseable for bundle portability but is not executable by Desic.

## Dependencies

Dependency installation happens only after the user explicitly grants execution trust to a bundle and a trusted interactive Agent invokes one declared entrypoint. Importing a bundle never installs packages.

Node bundles with dependencies must use root-level `package.json` and `package-lock.json`. Desic runs its packaged Node runtime and packaged npm CLI with:

```text
npm ci --ignore-scripts --omit=dev --no-audit --no-fund
```

Python bundles use a separate virtual environment and a pip requirements lock file where every requirement carries a `--hash=sha256:` value. The Systematic Research Python environment is never reused.

Environments are content-addressed and atomically built in the application cache:

```text
<app cache>/skill-runtimes/<skill-id>/<bundle-hash>-<runtime-id>-<lock-hash>/
```

A Node environment contains a separately verified snapshot of bundle files. Node scripts run from that snapshot so ordinary ESM package resolution reaches the environment's own `node_modules`; the source bundle remains immutable. Environment caches are dependency isolation, not an operating-system sandbox.

## Execution boundary

The canonical Desic tool is `skill.run` (provider alias `skill_run`). It accepts only:

```json
{ "skillId": "example", "entrypoint": "normalize", "input": {} }
```

Before execution, Desic verifies that the Skill is active for the current session, has user-granted execution trust, declares the requested entrypoint, and still matches every stored bundle file hash. The host selects the executable and script path; models cannot supply a command, executable, working directory, or package-manager flags.

`skill.run` is serialized and allowed only for the interactive main Agent. It is denied to subagents, team agents, and every background Profile Run. This preserves the existing Profile scope, account isolation, trade-opportunity, and credential boundaries.

The runtime uses JSON stdin/stdout, a timeout, a 64 KiB input limit, and a 256 KiB stdout/stderr limit. A Skill has no direct access to Desic credentials or structured trading controls through this runner. It may still be able to interact with the local operating system within the permissions of the desktop process; users must review open-source bundle code before granting execution trust.

## Agent Templates

An Agent Template is a reusable Profile collaboration preset. It carries only the collaboration topology and bounded reusable guidance:

- `instructions`: bounded reusable guidance, limited to 4,000 characters
- Agent name, role, responsibility, enabled state, and required-result state

Profile model, reasoning depth, Skills, account, environment, symbols, limits, and other execution settings remain Profile-owned. The former template-level `phase`, `skillIds`, `model`, and `reasoningDepth` fields are retained only for database compatibility and are ignored by the current editor/runtime. Staged orchestration, if introduced later, must model stages per Agent and implement scheduling semantics explicitly.

Custom Agents do not require a user-defined data-scope list. An unscoped custom Agent receives the Profile-permitted delegated read and precheck tools; the Profile account/environment/symbol and fixed tool safety boundaries still apply. Existing saved scope lists remain readable for compatibility.

Templates are configuration, not authority. Applying one never changes the Profile permission mode, account binding, environment, symbols, leverage, margin limits, wake/run limits, or Profile-owned Skills and model settings. Template instructions are appended after every fixed policy block in the background Run prompt, so they can shape analysis emphasis but cannot override trading rules or tool authority. Custom Agents inherit the Profile-permitted delegated read and precheck tools unless an existing saved scope list is being honored for compatibility; templates cannot declare sandbox, MCP, shell, or filesystem permissions.

### Codex preview import

The ordinary Template editor does not ask users for a Codex TOML path and does not expose provider-specific import controls. The backend read-only preview command remains available for a future provider-specific advanced flow; it does not participate in ordinary template editing and never adopts sandbox modes, MCP servers, tool lists, shell commands, approval policy, network access, environment variables, or working directories.

Legacy templates saved before v2 load with empty instructions, no template Skills, compatibility phase `primary`, no model, and `medium` reasoning depth. A queued Run stores its bounded template instruction snapshot at enqueue time, so later template edits or deletion do not change the Run prompt.

## Contributor guidance

- Keep `SKILL.md` useful on its own for Cline/Codex compatibility.
- Put Desic-specific runtime metadata in `desic-skill.json`.
- Commit lock files for every executable dependency set.
- Avoid package install hooks; they are ignored by Desic.
- Use structured JSON input/output and keep output bounded.
- Do not encode trade, account, credential, MCP, or sandbox policy in a bundle. Desic's host policy remains authoritative.
