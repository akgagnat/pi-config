# Repo aim and structure

## Aim

This repo is the source of truth for my personal Pi extension setup.

Its goals are to:

- keep my custom Pi extensions in version control
- make it easy to recreate my extension setup on a new Linux laptop or Mac
- document the small amount of Pi configuration needed to load those extensions
- keep a lightweight inventory of third-party Pi extensions/packages I use

## Scope boundaries

Included in v1:

- custom extensions authored in this repo
- setup documentation
- a minimal global Pi settings example
- a markdown inventory of third-party Pi items

Explicitly out of scope in v1:

- prompts
- skills
- themes
- project-local `.pi` scaffolding
- automated sync/apply scripts
- generated settings management
- formal package/install management for third-party items

## Folder responsibilities

### `extensions/`

Holds real custom Pi extensions that I actually use.

Conventions:

- write extensions in TypeScript
- allow simple one-file extensions
- use a directory per extension once it grows beyond a single file
- activate extensions explicitly by path in Pi settings

### `config/`

Holds the minimal global Pi config guidance for loading this repo's extensions.

This is documentation and example config only. It is not a generated or authoritative runtime config system.

### `inventory/`

Tracks third-party Pi extensions/packages I use, want to try, or have stopped using.

This is documentation only.

### `docs/`

Contains supporting docs:

- `setup.md` for getting running on a new machine
- `structure.md` for repository intent and boundaries

## Design principles

- keep the repo narrow in scope
- prefer clarity over automation
- avoid storing secrets
- avoid copying runtime files into this repo unless they are true source files
- keep activation explicit so experiments do not load accidentally
