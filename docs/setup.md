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

## 2. Decide which extensions and skills should be active

This repo does not auto-load everything in `extensions/` or `skills/`.

Instead, add only the specific extension file paths you want active, plus the repo `skills/` path if you want those shared skills available in Pi.

See:

- `config/settings.example.json`
- `config/README.md`

## 3. Update Pi global settings

Edit:

```text
~/.pi/agent/settings.json
```

Add or update the `extensions` array with the extension paths you want from this repo, and add the repo `skills/` path to the `skills` array if you want those skills loaded globally.

## 4. Reload Pi

Either:

- restart Pi, or
- run `/reload`

## 5. Verify

After adding a real extension or skill, confirm it loads in Pi.

Typical checks:

- Pi startup header shows the extension or skill as loaded
- the extension's command/tool/behavior appears as expected
- `/reload` succeeds without errors

## Notes

- Replace all example paths with your real local clone path.
- Keep secrets out of this repo and out of example config files.
- Keep extension file loading explicit; do not point Pi at the whole `extensions/` directory.
- Add the repo `skills/` path explicitly if you want its shared skills available across projects.
