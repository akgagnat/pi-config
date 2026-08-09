# Subagent Observability and Read-Only Inspector Research

## Status

Historical research and implementation-design reference. The core recommendation below is implemented: subagents run as isolated RPC subprocesses, feed an observable bounded job store, and have a full-screen read-only live inspector. The current implementation lives in `extensions/subagents/`; see issue #11 for the later comparison and settled follow-up decisions.

## Summary

The recommended design was:

> Run subagents as isolated RPC subprocesses, maintain their state in an observable bounded job store, and expose a full-screen read-only TUI inspector.

This preserves subprocess isolation while adding access to Pi's resolved child model, session statistics, messages, streaming events, and context-usage estimate.

## Research-time baseline (historical)

### Current flow

`extensions/subagents/index.ts`:

1. Creates an in-memory job.
2. Writes the profile prompt to a temporary file.
3. Starts a separate Pi process using:

   ```text
   pi --mode json -p --no-session
   ```

4. Parses JSON events from stdout.
5. Keeps completed messages, coarse logs, stderr, and final output.
6. Returns the result through either:
   - the original `subagent` tool result,
   - `subagent_wait`, or
   - a follow-up custom message for background jobs.

The current `/subagents-status` interaction is:

1. Show a static job list.
2. Select a job.
3. Open a static `ctx.ui.editor()` snapshot.

That editor is not a good inspector: it is visually editable, does not update, and only shows coarse logs.

### Existing job lifecycle

The extension owns a module-global job map:

```ts
const jobs = new Map<string, SubagentJob>();
```

A normal run is:

1. `subagent`, `subagent_spawn`, or a batch validates the profile, project trust, cwd, model, and task limits.
2. `createJob()` inserts an `initializing` job with logs and an `AbortController`.
3. `runAgent()`:
   - writes the profile body to a mode-0600 temporary Markdown file,
   - spawns a separate Pi process,
   - reads newline-delimited JSON from stdout,
   - stores completed `message_end` messages,
   - converts lifecycle and tool events into coarse text logs,
   - captures stderr and final assistant metadata.
4. Final assistant text is capped at 20 KB or 600 lines.
5. Foreground calls return the report directly. Background completion enters `ResultDelivery`; unless consumed by `subagent_wait`, it is injected into the parent with `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`.
6. Footer status is derived from the global job map.

Supporting modules:

- `profiles.ts`: profile discovery, frontmatter, and scope precedence
- `policy.ts`: child cwd containment
- `output.ts`: UTF-8 and line truncation
- `result-delivery.ts`: deferred versus explicitly consumed results
- `jobs.ts`: clone-safe snapshots and a separate generic `JobManager`
- `status.ts`: footer formatting

### Existing inspection

- `subagent_check`: latest ten coarse log lines
- `subagent_list`: recent summaries and clone-safe snapshots
- `/subagents-status`: select a job and open a static editor snapshot

There is no live inspector. The job map and subprocess references are private to `index.ts`; no observer API or event-bus contract is exposed.

### Information currently discarded

The child event stream already provides:

- streaming assistant text
- streaming thinking, when the provider exposes it
- tool-call argument deltas
- tool start, update, and end events
- partial tool output
- completed messages with token usage and cost
- turn boundaries
- retries
- compaction
- queue activity
- errors

`logJsonEvent()` currently reduces most of this to messages such as:

```text
tool read started
tool read finished
```

It does not retain tool arguments, partial output, turn structure, usage, or streaming text.

### Test coverage

`tests/subagents.test.ts` covers helpers, profile precedence, clone-safe details, unavailable profiles, status navigation, and `JobManager`. It does not exercise:

- real child spawning or JSON/RPC streams
- streaming `message_update`
- live UI rerendering
- usage and context accounting
- shutdown or reload with running children
- process timeouts or kill escalation

## Desired inspector

After selecting a job, the extension should open a read-only, live custom TUI component.

### Header

```text
sa-0004  dependency-review  working  1m 22s
worker · anthropic/claude-sonnet-4-5:high
Context: 42.3k / 200k (21%) · 4 turns · $0.083
cwd: ~/Projects/example
```

### Activity view

A bounded chronological timeline:

```text
12:42:10  Parent delegated task through tool call call_abc
12:42:11  Child session initialized
12:42:11  Turn 1 started
12:42:14  read package.json
12:42:14  read completed — 83 lines
12:42:18  bash pnpm test
12:42:31  bash completed — exit 0
12:42:36  Turn 1 ended — context 18.2k
12:42:36  Turn 2 started
```

### Conversation view

The child’s effective conversation:

- delegated user task
- assistant text
- optional thinking
- tool calls
- tool results
- compaction summaries

### Communication view

The inspector should make parent/child boundaries explicit:

```text
Parent → child
  parent session: ...
  parent tool call: ...
  delivery mode: background
  profile: worker
  model resolution: inherited from parent
  tools: read, grep, find, ls
  task: ...

Child → parent
  channel: deferred follow-up custom message
  full output: 31,420 bytes
  delivered output: 20,000 bytes, truncated
  consumed by subagent_wait: no
```

There is no shared context between the main agent and subagents. Communication currently consists of the initial task/profile configuration and the final returned report.

## Relevant Pi capabilities and constraints

### Extension API

Useful capabilities include:

- `ctx.ui.custom()` for focused components and overlays
- `tui.requestRender()` for event-driven redraw
- `ctx.ui.setWidget()` for persistent compact summaries
- `pi.events` for communication between extensions
- tool `onUpdate` while a parent tool execution remains active
- `pi.appendEntry()` for persistent TUI-only state
- `pi.sendMessage()` for messages that do participate in parent model context

Important boundaries:

- `ctx.getContextUsage()` reports only the parent session.
- `ctx.sessionManager` is the parent session manager.
- A normal extension cannot directly inspect a CLI child's internal `AgentSession`.
- `ctx.ui.custom()` is TUI-specific; RPC returns no custom component and JSON/print have no UI.

### JSON subprocess observability

JSON mode emits `AgentSessionEvent` records including:

- `message_update` text, thinking, and tool-call deltas
- `message_end` with final assistant usage, model, stop reason, and errors
- tool start/update/end
- turn and agent lifecycle
- queue, compaction, and retry events

This is sufficient for a useful live inspector without changing transport, but not for querying child state directly.

### Context-token feasibility

Final assistant messages contain usage such as:

```ts
{
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens,
  cost
}
```

Feasibility:

- Exact after a provider response: available from finalized assistant usage, subject to provider reporting semantics.
- Live during a response: provider-dependent; meaningful usage often arrives only at completion.
- Between completed responses: latest exact usage plus a local estimate for trailing tool/user/current output is possible.
- Percentage: requires the resolved child model's `contextWindow`.
- After compaction: mirror Pi and show unknown until a fresh post-compaction assistant response provides usage.

Context values must be labelled `exact`, `estimated`, or `unknown`. Cumulative token usage and current context size are different metrics and should be displayed separately.

### RPC subprocess observability

RPC mode produces the same streaming agent events and also supports read-only queries:

- `get_state`
- `get_messages`
- `get_session_stats`

`get_session_stats` includes Pi's own context estimate:

```ts
{
  contextUsage: {
    tokens,
    contextWindow,
    percent
  }
}
```

RPC therefore avoids duplicating Pi's context-usage calculation and exposes the resolved model object immediately.

## Spawn and lifecycle implications

### Benefits of subprocesses

- Strong context isolation
- Independent abort, timeout, and process kill
- Child failures are less likely to corrupt the parent runtime
- Ephemeral `--no-session` avoids child session files
- `shell: false` avoids shell interpolation

### Current risks

1. **The child loads normal Pi resources and extensions.** `--tools` limits active tools, not extension lifecycle handlers or OS permissions.
2. **Recursive subagents remain possible.** `PI_SUBAGENT=1` is set but not used as a recursion guard. A profile could enable subagent tools.
3. **Read-only execution is not universally enforced.** Defaults are read-only, but profile frontmatter may enable `bash`, `edit`, or `write`.
4. **Task text is passed in argv.** It may be visible in process listings. RPC can send it over stdin instead.
5. **Lifecycle ownership is weak.** `session_shutdown` does not abort running children, jobs are not parent-session scoped, and stale extension closures may handle completion after reload or replacement.
6. **Memory can grow without bounds.** The job map is never evicted; stderr, message arrays, and an unterminated stdout line can grow indefinitely.
7. **Parallel limits are incomplete.** Background spawn checks active jobs, but foreground and concurrent calls can exceed the intended global limit.
8. **Background abort is coupled to the parent tool signal.** Aborting the parent turn can terminate a supposedly background child.

### RPC-specific lifecycle

An RPC child remains alive after `agent_settled`, waiting for more commands. The extension must explicitly stop it after collecting final state.

Recommended sequence:

1. Spawn `pi --mode rpc --no-session` with piped stdin/stdout.
2. Wait until RPC accepts `get_state`.
3. Send the delegated task with `prompt`.
4. Consume streaming events into the job store.
5. Debounce `get_session_stats` queries after meaningful state changes.
6. On `agent_settled`, query final messages/stats and terminate the child.
7. On cancellation or timeout, send RPC `abort`, then escalate to `SIGTERM` and `SIGKILL` if necessary.

RPC child extensions can emit `extension_ui_request` and block. The parent must auto-cancel such requests or disable child extension discovery.

Pi supports:

```text
--no-extensions
```

Extension inheritance should become explicit, likely defaulting child processes to `--no-extensions`. This improves reproducibility, prevents recursive subagent spawning, and avoids unrelated extensions changing child behavior. It does mean profiles depending on extension-provided tools need an explicit opt-in policy.

## Implementation options

### Option 1: Keep JSON mode and capture more events

Keep the current subprocess command and build:

- an observable job store
- a bounded event timeline
- streaming message assembly
- usage aggregation
- a live TUI inspector

Context usage comes from the latest finalized assistant message, with the child's context window resolved through the model registry where possible.

#### Pros

- Smallest architectural change
- Preserves process and context isolation
- Existing abort and timeout behavior remains largely intact
- Enough information for a useful inspector
- No new transport protocol

#### Cons

- Exact context usage generally updates only when an assistant response finishes
- Trailing tool results and streaming output require estimates
- Cannot query the child's own context calculation
- Model aliases and fallback models can make context limits uncertain
- Stream deltas still need manual assembly

#### Best fit

A low-risk first release where live context may be labelled exact, estimated, or unknown.

### Option 2: Change child processes from JSON mode to RPC mode

Start each child as:

```text
pi --mode rpc --no-session ...
```

Keep stdin open, send the prompt through RPC, process streaming events, and query state/statistics.

#### Pros

- Preserves subprocess isolation
- Exposes the resolved model immediately, including context window
- Uses Pi's own context-usage calculation
- Can reconcile telemetry with `get_messages`
- Supports better future inspection, export, and debugging
- Continues to expose text, thinking, tools, retry, and compaction events

#### Cons

- More spawn and lifecycle work than JSON mode
- Child must be explicitly stopped after completion
- Requires request IDs and response/event multiplexing
- Cancellation should use RPC abort before process signals
- Child RPC UI requests must be cancelled or prevented
- Provider-exact usage still may not update during active streaming

#### Best fit

The requested end state: strong visibility while retaining isolation.

### Option 3: Run child `AgentSession`s in the parent process

Use `createAgentSession()` with an in-memory `SessionManager`, explicit model/tools, and a constrained resource loader.

#### Pros

- Fully typed events and state
- No JSON parsing
- Direct messages, model, system prompt, statistics, and context access
- Simpler synchronization with the inspector
- Task text is not exposed through argv

#### Cons

- Loses process isolation
- Child sessions share the parent process and resources
- Child crashes, leaks, and extensions can affect the main process
- Resource loading and extension suppression become extension responsibilities
- Cleanup around reloads and session replacement is more difficult

#### Best fit

A controlled embedded application where observability matters more than isolation.

### Option 4: Dedicated SDK worker process with custom IPC

Create a helper process that uses `createAgentSession()` internally and emits sanitized telemetry through a custom protocol.

```text
Main Pi extension
  ↕ typed IPC
Subagent worker process
  └─ AgentSession
```

#### Pros

- Direct SDK observability plus process isolation
- Strict control over resources and extension loading
- Clean long-term telemetry protocol
- Could expose system prompt construction and provider request stages
- Good foundation for remote or distributed agents

#### Cons

- Highest implementation and maintenance cost
- Requires protocol versioning
- Must solve helper packaging and runtime resolution
- Duplicates much of Pi RPC
- Requires substantially more integration testing

#### Best fit

A future subagent platform rather than an incremental extension improvement.

## UI options

### A. Select, then open a full-screen live inspector

Replace the static editor with `ctx.ui.custom()`.

**Pros:** simple keyboard/scroll model, ample room, clearly read-only, natural tabs.

**Cons:** temporarily replaces the normal editor and hides the main transcript.

### B. Split list/detail dashboard

Show jobs on the left and the selected job on the right.

**Pros:** best multi-job navigation and immediate selection updates.

**Cons:** more complex width handling and a poorer narrow-terminal experience.

### C. Floating overlay

Open the inspector over the current transcript.

**Pros:** main conversation remains visible.

**Cons:** less room, more focus complexity, and overlay APIs are experimental.

### D. Persistent widget

Show a compact selected-job summary beneath the editor.

**Pros:** continuous monitoring while working with the main agent.

**Cons:** unsuitable for full context and long logs; consumes height continuously.

### UI recommendation

Use a full-screen split list/detail component, falling back to a single-pane layout on narrow terminals. A compact widget can be added later.

Suggested keys:

- `↑/↓`: select a job or scroll
- `Enter`: inspect selected job
- `Tab`: switch Activity, Conversation, Communication, and Metadata
- `f`: toggle follow/autoscroll
- `t`: toggle thinking visibility
- `Esc`: back or close

The inspector should not contain cancel or steering actions. Cancellation remains a separate operation so the inspector is genuinely read-only.

## Recommendation

Choose **RPC subprocesses plus an observable job store and a full-screen read-only inspector**.

This gives the best balance:

- process isolation is retained
- current context usage comes from Pi itself
- the resolved child model is queryable
- streaming events expose what happens during a turn
- communication boundaries can be made explicit
- implementation is substantially simpler than a dedicated SDK worker

A transport-neutral job store should sit between RPC and the UI so the inspector is not coupled to process framing and can be tested with synthetic events.

## Required implementation changes

### 1. Extract an observable job store

Suggested structure:

```text
extensions/subagents/
  job-store.ts
  telemetry.ts
  rpc-transport.ts
  inspector.ts
```

The store should provide:

- immutable sanitized snapshots
- `subscribe(listener)`
- bounded timeline buffers
- bounded stderr and output
- completed-job eviction
- transport-neutral events
- parent session and parent tool-call correlation

### 2. Replace coarse logging with structured telemetry

For example:

```ts
type TelemetryEvent =
  | { type: "turn-start"; turn: number; at: number }
  | { type: "text-delta"; contentIndex: number; delta: string }
  | { type: "thinking-delta"; contentIndex: number; delta: string }
  | { type: "tool-start"; id: string; name: string; args: unknown }
  | { type: "tool-update"; id: string; partialResult: unknown }
  | { type: "tool-end"; id: string; isError: boolean }
  | { type: "usage"; usage: Usage; contextQuality: "exact" | "estimated" | "unknown" }
  | { type: "retry"; attempt: number; maxAttempts: number; delayMs: number }
  | { type: "compaction"; phase: "start" | "end"; reason: string };
```

Do not retain repeated cumulative partial tool results indefinitely. Replace current state and keep compact timeline summaries.

### 3. Track communication correlation

Each job should record:

- parent session ID
- parent tool-call ID
- parent turn or entry when available
- foreground, background, or batch mode
- result delivery method
- whether `subagent_wait` consumed it
- original and delivered output sizes
- truncation details

The current implementation discards `_toolCallId` in every subagent tool.

### 4. Correct lifecycle ownership

The current global jobs and per-extension callbacks are unsafe across reload and session replacement:

- running children are not cancelled on `session_shutdown`
- old completion callbacks retain stale `pi` and UI references
- result delivery is cleared while jobs may continue
- completed jobs are never evicted

Choose and document whether children are cancelled or rebound on reload/replacement. Cancellation is simpler and safer; rebinding is more convenient but considerably harder to make correct.

### 5. Harden child execution

Regardless of transport:

- use `PI_SUBAGENT` as a recursion guard
- default to `--no-extensions` unless inheritance is explicitly needed
- cap stderr
- cap unterminated stdout buffers
- cap retained completed messages
- enforce concurrency globally across foreground and background jobs
- remove abort listeners when children exit
- make timeout, RPC abort, `SIGTERM`, and `SIGKILL` idempotent
- send task text through RPC stdin rather than argv

### 6. Clarify model resolution

There is a precedence issue in the current implementation.

`runAgent()` uses:

```ts
requestedModel || agent.model || PI_MODEL
```

But callers normally pass the inherited parent model as `requestedModel`, so a profile model is effectively ignored.

Recommended precedence:

```text
per-task model
→ top-level requested model
→ profile model
→ inherited parent model
→ Pi default
```

The inspector should display both the source and final resolved model.

### 7. Protect privacy and performance

- Thinking, commands, arguments, paths, and output may contain secrets.
- Hide thinking by default and require an explicit toggle.
- Keep inspector telemetry TUI-only; do not use `pi.sendMessage()` for progress.
- Coalesce token-rate updates and throttle redraw to roughly 5–10 Hz.
- Use ring buffers and completed-job eviction.
- Treat JSON/RPC responses as an external boundary and validate the required shape.

## Milestone plan

### Milestone 1: Repository and lifecycle foundations

- Align Pi package versions and local installation.
- Extract the job store.
- Add bounded retention, snapshots, subscription, and eviction.
- Add parent session/tool-call correlation.
- Define shutdown and reload behavior.

### Milestone 2: RPC transport

- Add an RPC subprocess adapter.
- Send prompts through stdin.
- Multiplex events and responses.
- Query resolved state and session statistics.
- Handle abort, timeout, process exit, and final shutdown.
- Disable or explicitly control child extensions.

### Milestone 3: Live inspector

- Replace the static editor with a full-screen read-only component.
- Add responsive split and narrow layouts.
- Add Activity, Conversation, Communication, and Metadata views.
- Add scrolling, follow mode, and hidden-thinking toggle.
- Throttle redraw and unsubscribe cleanly.

### Milestone 4: Integration and hardening

- Add real or fixture-driven RPC stream tests.
- Cover malformed records, process errors, and oversized streams.
- Test timeout and abort escalation.
- Test reload/session shutdown behavior.
- Verify foreground, background, wait, and deferred-result delivery.
- Document context accuracy and privacy behavior.

## Repository consistency discovered during research

At research time:

- `package.json` and `pnpm-lock.yaml` targeted Pi `^0.82.0`.
- Local `node_modules` resolved Pi packages at `0.79.10`.
- The globally executed Pi was `0.84.1`.
- `pnpm typecheck` failed because the stale local installation lacked `@earendil-works/pi-tui` and `typebox`.

A clean dependency install and explicit supported Pi version are prerequisites for implementation. RPC APIs and event types must be tested against the pinned version.
