# Config notes

This folder contains a minimal example for wiring this repo's extensions into Pi.

## Files

- `settings.example.json` - example global Pi settings snippet

## How to use it

1. Open `~/.pi/agent/settings.json`.
2. Copy the relevant `extensions` entries.
3. Replace placeholder paths with the real path to your local clone.
4. Keep only the extension files you want active.

## Path examples

Preferred clone path on both Linux and macOS:

```text
~/Projects/pi-config
```

Concrete examples:

```json
{
  "extensions": [
    "/home/akgagnat/Projects/pi-config/extensions/pr.ts"
  ]
}
```

```json
{
  "extensions": [
    "/Users/akgagnat/Projects/pi-config/extensions/pr.ts"
  ]
}
```

Use explicit file paths instead of pointing Pi at the entire `extensions/` directory.
