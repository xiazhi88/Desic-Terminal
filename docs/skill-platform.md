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

## Agent definitions

Agent Templates have been superseded by the Agent library. A reusable Profile preset with template-level `instructions`, `phase`, `skillIds`, `model`, or `reasoningDepth` is no longer an editing or runtime concept; collaboration is expressed as a per-Profile checklist over the library instead:

- An Agent is `<app workspace>/.cline/agents/<id>/AGENTS.md`, a sibling of the Skill bundles directory. Frontmatter carries `id`, `name`, `role`, `envelope`, `scopes`, `skills`, `requiresAccount`, `source`, `version`, and `createdAt`; the body is that expert's system prompt and optional `references/*.md` files.
- The Profile stores only the checked list (`enabledAgentIds`). Checking an Agent allows the Main Agent to consult it; an empty list means the Main Agent completes the run alone. Nothing is assigned automatically and there is no check-count limit.
- Agents never own execution settings: model, reasoning depth, Skills, account, environment, symbols, leverage, margin limits, and wake/run limits stay Profile-owned, and an Agent file cannot declare sandbox, MCP, shell, or filesystem permissions. The fixed runtime shell (read-only role, evidence timestamps, untrusted reports) is prepended by the sidecar and cannot be overridden by an Agent file.
- `scopes` is an intent declaration over read-only data domains (`market`, `derivatives`, `intelligence`, `account`, `history`); an empty array means all read-only tools. The effective boundary is still enforced at runtime through account binding, Skill requirements, the read-only role, and the tool allowlist — never by the Agent file alone.
- Built-in Agents are installed idempotently and are never overwritten when a user edits them locally; they can only be duplicated into `custom` Agents.

For rollback, the old `ai_agent_schemes` table and the old Profile columns are retained read-only: reading a Profile migrates the old `off` / `auto` / `custom` modes and any old scheme members into library entries (`source: custom`) plus the checked list, and counts template-level `instructions` as dropped in the migration report. Runs keep `templateSnapshotJson` for read-only history display; it is no longer injected into any prompt.

### Codex preview import

The ordinary Agent editor does not ask users for a Codex TOML path and does not expose provider-specific import controls. The backend read-only preview command (`ai_agent_template_preview_codex`) remains available for a future provider-specific advanced flow; it does not participate in ordinary Agent editing and never adopts sandbox modes, MCP servers, tool lists, shell commands, approval policy, network access, environment variables, or working directories.

## Contributor guidance

- Keep `SKILL.md` useful on its own for Cline/Codex compatibility.
- Put Desic-specific runtime metadata in `desic-skill.json`.
- Commit lock files for every executable dependency set.
- Avoid package install hooks; they are ignored by Desic.
- Use structured JSON input/output and keep output bounded.
- Do not encode trade, account, credential, MCP, or sandbox policy in a bundle. Desic's host policy remains authoritative.
