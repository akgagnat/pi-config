# Subagent extension research

Sources reviewed:

- Pi extension docs: `/home/akgagnat/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- Pi usage docs / README CLI flags: `/home/akgagnat/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/README.md`
- First-party subagent example: `/home/akgagnat/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/`
- First-party dynamic tools example: `/home/akgagnat/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/dynamic-tools.ts`
- Local extension style: `extensions/pr.ts`

## Findings

- Pi extensions are TypeScript modules with a default factory receiving `ExtensionAPI`; tools are registered with `pi.registerTool()`, commands with `pi.registerCommand()`. Source: `docs/extensions.md`.
- Extension tools should define parameter schemas and can stream partial updates via `onUpdate`, return user-visible `content`, and preserve richer machine-readable data in `details`. Source: `docs/extensions.md` and first-party `subagent/index.ts`.
- Pi CLI supports non-interactive child runs with `-p`, JSON event output with `--mode json`, ephemeral runs with `--no-session`, and restricted tool sets with `--tools`. Source: `README.md` CLI tables.
- The first-party subagent example isolates context by spawning a separate `pi --mode json -p --no-session` process per delegated task, then parses JSON events from stdout to recover assistant messages and usage. Source: `examples/extensions/subagent/index.ts`.
- Agent profiles in the first-party example are simple Markdown files with frontmatter (`name`, `description`, optional `tools`, optional `model`) and body as the agent system prompt. User agents live under the global Pi agent dir; project agents live under the nearest project `.pi/agents`. Source: `examples/extensions/subagent/agents.ts`.
- The first-party example treats project-local agents as security-sensitive and prompts before running them, because repo-controlled instructions can execute with the user's Pi/tool permissions. Source: `examples/extensions/subagent/index.ts`.
- The first-party example caps parallelism (`MAX_PARALLEL_TASKS`, `MAX_CONCURRENCY`) and output size per task. Source: `examples/extensions/subagent/index.ts`.
- Existing local code (`extensions/pr.ts`) favors small helper functions, explicit command failure handling, interactive guards for TUI-only UI, and returning early with `ctx.ui.notify()` for invalid preconditions.

## Best-practice shape for v1

1. Keep the extension one file to start.
2. Reuse the Pi CLI as the subagent runtime instead of embedding lower-level SDK APIs.
3. Store agents as Markdown profiles so adding a new role is data-only.
4. Start with one tool (`subagent`) plus one command (`/subagents`) to inspect available agents.
5. Support single task and small parallel batches; defer chains, custom renderers, persistent job tracking, and richer UI until later.
6. Restrict tools per subagent using profile frontmatter and pass `--tools` to child Pi.
7. Use `--no-session` for child agents so they do not pollute normal session history.
8. Propagate aborts from the parent tool call to child processes.
9. Guard project-local agents with trust checks and user confirmation.
10. Return concise summaries in tool content and preserve complete per-agent details in `details` for later renderers/debugging.
