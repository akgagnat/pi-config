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

Unsupported fields or invalid values cause subagent launch to fail with a clear error; they never silently select another value. `timeoutMs` may also be supplied per `subagent` or `subagent_spawn` call and uses the same 1,000–7,200,000 ms bounds.
