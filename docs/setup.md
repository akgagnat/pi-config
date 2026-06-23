# Setup

## Purpose

These steps wire this repo into Pi on a new machine.

This repo assumes Pi is already installed.

## Preferred clone location

Any path works, but the preferred location is:

- Linux: `~/Projects/pi-config`
- macOS: `~/Projects/pi-config`

## 1. Clone the repo

```bash
git clone <repo-url> ~/Projects/pi-config
cd ~/Projects/pi-config
```

## 2. Decide which extensions should be active

This repo does not auto-load everything in `extensions/`.

Instead, add only the specific extension file paths you want active to Pi settings.

See:

- `config/settings.example.json`
- `config/README.md`

## 3. Update Pi global settings

Edit:

```text
~/.pi/agent/settings.json
```

Add or update the `extensions` array with the extension paths you want from this repo.

## 4. Reload Pi

Either:

- restart Pi, or
- run `/reload`

## 5. Verify

After adding a real extension, confirm it loads in Pi.

Typical checks:

- Pi startup header shows the extension as loaded
- the extension's command/tool/behavior appears as expected
- `/reload` succeeds without errors

## Notes

- Replace all example paths with your real local clone path.
- Keep secrets out of this repo and out of example config files.
- If `extensions/` is still empty, wait to add extension paths until you create the first real extension.
