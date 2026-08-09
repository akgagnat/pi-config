# Config notes

This folder contains a minimal example for wiring this repo's extensions into Pi.

## Files

- `settings.example.json` - example global Pi settings snippet

## How to use it

1. Open `~/.pi/agent/settings.json`.
2. Copy the `extensions` entry.
3. Replace the placeholder path with the real path to your local clone.
4. Optionally add the global `subagents` block shown in the example to set operational limits for this extension.

## Path examples

Preferred clone path on both Linux and macOS:

```text
~/Projects/pi-config
```

Concrete examples:

```json
{
  "extensions": [
    "/home/akgagnat/Projects/pi-config/extensions"
  ]
}
```

```json
{
  "extensions": [
    "/Users/akgagnat/Projects/pi-config/extensions"
  ]
}
```

Point Pi at the whole `extensions/` directory.

## Subagent limits

`subagents` is an extension-owned **global** `settings.json` block. Omit it to use the defaults shown in `settings.example.json`. All supplied values must be integers within these bounds:

| Setting | Purpose | Bounds |
| --- | --- | --- |
| `maxConcurrent` | Global concurrent-job cap | 1–16 |
| `defaultTimeoutMs` | Default maximum child runtime | 1,000–7,200,000 ms |
| `outputMaxBytes` | Final delivered output cap | 1,024–1,000,000 bytes |
| `outputMaxLines` | Final delivered output line cap | 1–10,000 |
| `logMaxChars` | Per-job stderr/activity retention cap | 1,024–1,000,000 characters |
| `completedJobRetention` | Completed in-memory jobs to retain | 1–100 |
| `journalMaxEvents` | Telemetry records retained in each journal | 1–2,000 |
| `journalRetention` | Completed journals retained | 1–1,000 |
| `journalMaxAgeMs` | Maximum journal age | 60,000–31,536,000,000 ms |

Completed runs are also written best-effort to `~/.pi/agent/subagent-journals/<uuid>/`. Each private (`0700`) directory contains versioned `status.json`, bounded `events.jsonl`, `output.txt`, and `stderr.txt` files (`0600`). The journal is a post-mortem projection only: it is not a queue, does not resume a child, and children still terminate when their parent session shuts down. Artifact writes and cleanup never block or fail a live child; malformed or partial artifacts are ignored by the read-only reader seam for the future inspector.

Unsupported fields or invalid values cause subagent launch to fail with a clear error; they never silently select another value. `timeoutMs` may also be supplied per `subagent` or `subagent_spawn` call and uses the same 1,000–7,200,000 ms bounds.

## Mid-flight steering

`subagent_steer` sends an instruction to an existing **working** RPC child through Pi's `steer` command. A successful result means the child RPC process accepted the instruction into its steering queue; it does not prove that the model read or complied with it. Steering never restarts, replaces, resumes, or revives a child.

Unknown, initializing, completed, failed, aborted, and cancellation-in-progress jobs are rejected. If cancellation begins after a steer has already been written, that delivery may still be reported as accepted, but cancellation continues and the child is still terminated. RPC rejection and process-exit races are reported as failed delivery. Requested and final delivery outcomes are retained in a bounded steering ledger and shown in the inspector's Communication view; instructions are also part of the bounded journal telemetry.

## Explicit child extensions and escalation

Children still use `--no-extensions`, so global and project extensions are never discovered or inherited. A profile may opt into trusted child-only extension files with comma-separated scalar frontmatter:

```yaml
tools: read,grep,contact_supervisor
extensions: extensions/subagents/contact-supervisor.ts
```

Each path must be relative to the profile's trust root (the config repository root, the user agent directory, or the trusted project's `.pi` directory). Absolute paths, traversal, missing/non-files, unsupported file types, and symlink escapes are rejected before a job is created. Pi receives each canonical file through an explicit `--extension` argument. `tools` remains the active-tool allowlist, so an extension tool must also be named there. Tool allowlisting does **not** sandbox an extension: an explicitly allowed extension is trusted executable code with the user's process permissions, environment, and event hooks.

The bundled child-only `contact_supervisor` tool supports blocking `decision` and structured `input` requests plus non-blocking `progress` updates. It is for material ambiguity or missing information, not routine completion handoff. The parent inspects requests with `subagent_requests` and replies explicitly with `subagent_reply`; it may instead use `subagent_steer` for unsolicited instruction changes. Requests use UUID correlation, are scoped to the live parent session/job, permit at most 8 pending requests per job, retain at most 50 recent records, cap envelopes and replies at 20,000 UTF-8 bytes, and time out after 120 seconds. Cancellation, process exit, and parent shutdown cancel pending requests; late, duplicate, and cross-session replies fail.

No context fork occurs. The child receives only its delegated task, explicit replies, and steering instructions—not the parent conversation or system prompt. Request/reply telemetry is bounded and may be retained unencrypted in the post-mortem journal under `~/.pi/agent/subagent-journals`; do not send secrets that should not be persisted. Supervisor queues are live-only and never resume across sessions.

## Active jobs and completion notices

In TUI mode, active jobs appear in a compact widget below the editor with job id/name, elapsed time, and latest bounded activity. The widget contains the `/subagents` path to the existing read-only inspector and disappears when no jobs are active. It is disabled outside TUI mode and is always cleared on shutdown/reload. Live widget and progress telemetry are display-only and are never injected into model context.

Successful background completions that occur within a deterministic 250 ms window are combined into one deferred follow-up, reducing interruption noise. Failed and aborted jobs bypass that window and notify promptly without forcing an early flush of pending successes. `subagent_wait` consumes both pending and future deferred notices for the requested ids; whichever operation wins the event-loop race owns delivery, so a result returned by `subagent_wait` is not later repeated. Completion batches and timers are in-memory only and are discarded on shutdown/reload.
