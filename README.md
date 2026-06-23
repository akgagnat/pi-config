# pi-config

Personal repo for my custom Pi extensions, plus the minimal docs and config examples needed to load them on a new machine.

## Scope

This repo currently tracks:

- custom Pi extensions I actually use
- setup notes for wiring this repo into Pi
- a minimal example `settings.json` snippet
- an inventory of third-party Pi extensions/packages I use

Out of scope for v1:

- prompts
- skills
- themes
- project scaffolding
- sync/apply tooling
- generated config management

## Structure

```text
extensions/            # real custom Pi extensions
config/                # minimal global Pi settings example + notes
inventory/             # third-party Pi extension/package inventory
docs/
  setup.md             # setup on a new machine
  structure.md         # repo aim, boundaries, folder responsibilities
package.json           # minimal repo-local Node metadata
tsconfig.json          # minimal TypeScript authoring config
```

## Quick start

1. Clone this repo, preferably to `~/Projects/pi-config`.
2. Add the extension paths you want from this repo to `~/.pi/agent/settings.json`.
3. Restart Pi or run `/reload`.
4. See:
   - `docs/setup.md`
   - `docs/structure.md`
   - `config/README.md`

## Notes

- Extension activation is explicit: list only the extension files you want active.
- `extensions/` should contain only real extensions, not starter samples.
- Third-party tools are documented in `inventory/third-party.md`; they are not managed by this repo.
