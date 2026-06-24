# Config notes

This folder contains a minimal example for wiring this repo's extensions and skills into Pi.

## Files

- `settings.example.json` - example global Pi settings snippet

## How to use it

1. Open `~/.pi/agent/settings.json`.
2. Copy the relevant `extensions` entries and the `skills` path.
3. Replace placeholder paths with the real path to your local clone.
4. Keep only the extension files and skills paths you want active.

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
  ],
  "skills": [
    "/home/akgagnat/Projects/pi-config/skills"
  ]
}
```

```json
{
  "extensions": [
    "/Users/akgagnat/Projects/pi-config/extensions/pr.ts"
  ],
  "skills": [
    "/Users/akgagnat/Projects/pi-config/skills"
  ]
}
```

Use explicit file paths for extensions, and an explicit `skills/` path for the shared skills you want Pi to discover.
