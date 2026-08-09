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
