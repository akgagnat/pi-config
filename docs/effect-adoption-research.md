# Effect Adoption Research

## Status

Research and decision reference. **Recommendation: do not adopt [Effect](https://effect.website/) in this repo.** Adopt the three zero-dependency patterns in ["Recommended: the zero-dependency subset"](#recommended-the-zero-dependency-subset) instead. Revisit if Pi itself ever adopts Effect, or if this repo grows a genuinely concurrent multi-extension runtime.

## The premise to correct first

The motivating assumption was: *"the pi agent itself uses effect, and these are pi extensions, so it makes sense to use it."*

Pi does not use Effect. Verified against the published packages at `0.84.1`:

| Package | Runtime dependencies |
| --- | --- |
| `@earendil-works/pi-coding-agent` | `diff`, `glob`, `jiti`, `yaml`, `chalk`, `ignore`, `semver`, `undici`, `typebox`, `minimatch`, `cross-spawn`, `grok-mermaid`, `highlight.js`, `hosted-git-info`, `proper-lockfile`, plus sibling `pi-*` packages |
| `@earendil-works/pi-ai` | `openai`, `typebox`, `partial-json`, `@google/genai`, `@anthropic-ai/sdk`, `@opentelemetry/api`, `@mistralai/mistralai`, AWS/Smithy, proxy agents |
| `@earendil-works/pi-agent-core` | `diff`, `yaml`, `ignore`, `typebox` |
| `@earendil-works/pi-tui` | `marked`, `get-east-asian-width` |
| `@earendil-works/pi-protocol` | `typebox` |
| `@earendil-works/pi-client` | `@earendil-works/pi-protocol` |

`pnpm-lock.yaml` in this repo contains the full transitive closure of those packages. There is no `effect` entry anywhere in it.

Pi's stack is **TypeBox + plain `async`/`await` + `AbortSignal` + Node `EventEmitter`**. Its extension surface is Promise-and-callback shaped:

```ts
// extensions/subagents/index.ts:860
async execute(toolCallId, params, _signal, _onUpdate, ctx) { ... }   // must return a Promise
pi.on("session_shutdown", async () => { ... })                       // must return a Promise
pi.registerTool({ parameters: SubagentParamsSchema })                // must be a TypeBox schema
```

So the "consistency with the host" argument does not just fail to support adoption — it argues against it. Adopting Effect here means this repo would be the *only* Effect code in the entire stack, with a translation layer at every boundary.

## Where Effect would genuinely help

This is not a case of "no use case." The repo has real, concentrated async-lifecycle complexity, and Effect targets exactly that complexity. Four honest wins:

### 1. Resource safety in `runRpcAgent` — the strongest case

`extensions/subagents/index.ts:448-649` is a 202-line function that manages **eight** resources acquired in sequence, each needing conditional teardown:

```ts
let tempDir: string | undefined;          //  → rm()
let child: ReturnType<typeof spawn>;      //  → SIGTERM, then SIGKILL
let client: RpcProcessClient | undefined; //  → dispose()
let unsubscribeRpc: (() => void) | undefined;
let unregisterSteering: (() => void) | undefined;
let unregisterEscalation: (() => void) | undefined;
let abortSignal / abortHandler;           //  → removeEventListener
let terminateTimer / killTimer;           //  → clearTimeout
```

...unwound in a 15-line `finally` block that must get the order right and tolerate every partial-acquisition state. Plus six more flags (`sigtermSent`, `sigkillSent`, `wasAborted`, `hasSettled`, `promptAccepted`, `abortRequested`) tracking where in the lifecycle we are.

Effect's `Effect.acquireRelease` / `Scope` makes each release travel with its acquisition, and guarantees release runs on success, failure, *and* interruption. The `finally` block disappears; so do most of the flags. This is the single place where Effect would meaningfully reduce the chance of a leak.

### 2. Typed errors instead of stringly-typed failures

Every failure in this repo is `new Error(string)`, and callers re-derive meaning from status fields or message matching:

```ts
result.status = wasAborted ? "aborted" : result.stopReason === "error" ? "failed" : "done";
```

`runRpcAgent` alone has at least eight distinct failure modes — spawn failure, RPC timeout, transport fatal, oversized frame, settlement timeout, abort-before-prompt, abort-while-prompting, artifact-write failure — all collapsed into one `errorMessage: string`. With `Data.TaggedError`, the failure set appears in the type signature (`Effect<RunResult, SpawnFailed | RpcTimeout | SettlementTimeout, never>`) and the compiler checks that each is handled.

### 3. Interruption and timeouts as primitives

Three hand-rolled timeout races exist today, each with its own timer-cleanup discipline:

- `RpcProcessClient.waitForSettled` (`rpc.ts:158-177`)
- `SteeringRegistry.waitForFinalSettlement` (`steering.ts:83-98`)
- the abort race in `subagent_wait` (`index.ts:904-918`)

Effect replaces all three with `Effect.timeout` / `Effect.race`, which handle timer cleanup and loser-cancellation structurally. Fiber interruption also propagates automatically, which is the manual work being done by `AbortSignal.any([signal, job.abortController.signal])` plus the `abortHandler` closure plus the SIGTERM→SIGKILL timer ladder.

### 4. Real concurrency control instead of rejection

Two places want a semaphore and don't have one:

- `assertCapacity` (`index.ts:321`) **throws** when `maxConcurrent` is exceeded rather than queueing.
- `CwdMutationLock` (`mutation-lock.ts`) is a non-blocking mutex that fails the job outright when a directory is busy, producing the whole `mutationLockFailure` code path (`index.ts:651-692`, 42 lines that exist purely to render a lock failure as a completed job).

`Effect.Semaphore` gives real queuing with automatic release on interruption. That 42-line function could largely go away.

Two smaller ones worth naming: `Deferred` would remove the `resolveSettlement!` / `rejectSettlement!` definite-assignment dance in `steering.ts:37-47`, and a `Queue` + worker fiber would replace `RunJournal`'s promise-chain-as-a-queue (`journal.ts:129-134`), where `this.pending = this.pending.then(...).catch(() => {})` serializes writes and silently swallows every error.

## Why the answer is still no

### The boundary tax is paid at every entry point, forever

This repo registers 8 tools, 2 commands, and 2 event handlers. Every one is a Promise/callback boundary requiring `Effect.runPromise` or `Effect.runFork`. Effect handles this reasonably — `Effect.runPromise(effect, { signal })` accepts an `AbortSignal`, and `Effect.tryPromise` hands you one — but the translation is permanent overhead that buys nothing at the boundary itself.

### TypeBox is mandatory, so `Schema` cannot replace it

`pi.registerTool({ parameters })` requires a TypeBox schema; Pi derives the model-facing JSON Schema from it. Effect `Schema` would have to coexist with TypeBox rather than replace it, meaning two validation libraries and a conversion layer. That kills one of Effect's better selling points for this codebase.

### It would be the repo's first runtime dependency

Today `package.json` has **only `devDependencies`**. Pi resolves `@earendil-works/*` and `typebox` from its own installation at runtime; a fresh clone needs no `npm install` to work, and `docs/setup.md` correctly has no install step.

Adding Effect changes that. Per Pi's extension docs, npm packages resolve from a `package.json` + `node_modules` next to or above the extension — so it must move to `dependencies`, `docs/setup.md` gains a mandatory `pnpm install --prod` step, and every machine setup grows a failure mode that does not exist today. For a personal config repo whose stated design principle is *"keep the repo narrow in scope / prefer clarity over automation"* (`docs/structure.md`), that is a real cost. Effect is ~27 MB unpacked, against 3,497 lines of source.

### The timing is bad

`effect@latest` is `3.22.1`. `effect@rc` is `4.0.0-rc.108`, and as of July 2026 the `effect-smol` repo was archived into the canonical repo with `main` now being v4. Adopting v3 today means a major migration is already visible on the horizon; adopting the v4 RC means building a personal tool on a pre-release. Neither is a good bet for infrastructure you want to *stop* thinking about.

### The regression risk is disproportionate

The git history — `harden output and RPC bounds`, `isolate live inspector rendering`, `serialize mutation-capable jobs per cwd`, `centralize admission and operational limits` — shows this code's race semantics were tuned deliberately. Some of it is genuinely subtle:

- `SteeringRegistry.observeSettled` deliberately refuses to settle while `inFlight > 0`, then re-checks `acceptedSinceObservedSettlement` in a `finally` (`steering.ts:63-73`, `steering.ts:135-145`).
- `CompletionBatcher` has a three-state reserve/release/consume protocol so `subagent_wait` and the 250 ms deferred-notice window cannot both deliver the same result.
- `EscalationIngress` buffers requests that arrive after prompting starts but before the parent channel attaches.

A framework rewrite touches all of it. Effect would make the *next* such bug less likely; it would also give you a solid chance of reintroducing the ones already fixed.

### Test friction

Tests run on `node:test` with `--experimental-transform-types` (`package.json`). Effect's testing story is built around `@effect/vitest` (`TestClock`, `it.effect`), which is Vitest-only. You would either wrap everything in `Effect.runPromise` inside `node:test` — losing `TestClock`, which is the main reason to want Effect's test tooling for this timer-heavy code — or migrate the runner too.

## Size of the change

Source is 3,497 lines across `extensions/` + `utils/`; tests are 1,284 lines.

| Category | Lines | Effect benefit |
| --- | --- | --- |
| `index.ts` async lifecycle (`runRpcAgent`, `runManagedAgent`, `mutationLockFailure`, `startBackground`, shutdown, `subagent_wait`) | ~500 | **High** |
| `rpc.ts` | 326 | Medium — stream decoding + pending-request correlation |
| `journal.ts` | 174 | Medium — queue + best-effort writes |
| `steering.ts` | 166 | Medium — `Deferred` + settlement race |
| `escalation.ts` | 160 | Medium — timers + pending map |
| `completion-batcher.ts` | 87 | Low-medium |
| `output-artifact.ts` | 75 | Low — atomic write, already correct |
| `mutation-lock.ts` | 29 | Medium as a `Semaphore` |
| **Subtotal — would change** | **~1,517** | |
| `job-store.ts` (413), `inspector.ts` (315), rest of `index.ts` (~630), `active-widget.ts` (103), `settings.ts` (87), `profiles.ts` (85), `jobs.ts` (85), `result-delivery.ts` (47), `child-extensions.ts` (36), `contact-*.ts` (76), `output.ts`/`telemetry.ts`/`policy.ts`/`status.ts` (67), `utils/` (34) | **~1,980** | **None** — pure functions, sync I/O, TUI rendering, in-memory data structures |

So roughly **43% of the source has any Effect-shaped complexity at all**, and the concentrated high-value part is a single ~500-line region of `index.ts`.

### Effort estimates

| Option | Scope | Effort | Risk |
| --- | --- | --- | --- |
| **A. Full adoption** | ~1,517 source lines rewritten, ~900 of 1,284 test lines reworked, `Layer`-based wiring, TypeBox↔Schema bridge, runner decision | **3–6 focused days** if already fluent in Effect; **2–4 weeks** including the learning curve | **High** — touches every tuned race |
| **B. Effect only inside `runRpcAgent`** | Scope/acquireRelease for the 8 resources, `Effect.runPromise` at one boundary, rest untouched | **1–2 days** | Medium | 
| **C. Zero-dependency subset (recommended)** | ~120 net lines across 4 files | **Half a day** | **Low** — incremental, testable one at a time |

Option B is the trap: it still costs the runtime dependency, the setup step, the 27 MB, and the v3→v4 migration, while capturing only the resource-safety win — which Option C also captures.

## Recommended: the zero-dependency subset

Node 24 (CI target) and TypeScript 5.9 (repo) already provide most of what makes the four wins above attractive.

**1. Replace the manual `finally` unwind with a resource stack.** ~15 lines, works on any Node:

```ts
// utils/resources.ts
export class ResourceStack {
	private readonly releases: Array<() => void | Promise<void>> = [];
	add<T>(value: T, release: (value: T) => void | Promise<void>): T {
		this.releases.push(() => release(value));
		return value;
	}
	async release(): Promise<void> {
		for (const release of this.releases.reverse()) {
			await Promise.resolve().then(release).catch(() => {});
		}
	}
}
```

This is `acquireRelease`'s actual value — release travels with acquisition, LIFO order, partial acquisition tolerated — minus the framework. It removes the eight `let x: T | undefined` declarations and the 15-line `finally` from `runRpcAgent`.

If your Node 24 minor is ≥ 24.4 (V8 ≥ 13.8), `await using` + `Symbol.asyncDispose` gives the same thing as syntax. Verify before relying on it — `--experimental-transform-types` only strips types, so the runtime must support the syntax natively, and Node 22 does not.

**2. `Promise.withResolvers()`** (native since Node 22) for `steering.ts:37-47`, deleting the `resolveSettlement!` / `rejectSettlement!` definite-assignment dance.

**3. A shared `withTimeout` / `withAbort` helper** (~20 lines) replacing the three hand-rolled races in `rpc.ts:158`, `steering.ts:83`, and `index.ts:904`, with timer cleanup in one place.

**4. Optionally, a small async semaphore** (~25 lines) so `assertCapacity` and `CwdMutationLock` queue instead of failing the job — which would let `mutationLockFailure` (42 lines) mostly disappear.

That is roughly 120 lines of new local code, no new dependency, no setup change, no v4 migration, and each piece lands and gets tested independently.

## When to revisit

- **Pi adopts Effect.** Then the consistency argument becomes real and the boundary tax largely vanishes. Watch `@earendil-works/pi-coding-agent` dependencies.
- **Effect 4.0 goes stable** *and* one of the above triggers also holds.
- **This repo grows into a runtime**, not a config repo — several interacting extensions with shared services, retry policies, and structured concurrency. `Layer`-based dependency injection and `Schedule` start earning their keep at that point. Nothing in the current scope (`docs/structure.md`) points that way.

## Sources

- npm registry metadata for `@earendil-works/pi-*@0.84.1`, `effect@3.22.1` / `4.0.0-rc.108`, `@effect/platform@0.97.1`
- `pnpm-lock.yaml` (full transitive closure; no `effect` entry)
- [Pi extension docs — jiti loading and npm dependency resolution](https://github.com/earendil-works/pi)
- [This Week in Effect, 2026-07-17](https://effect.website/blog/this-week-in-effect/2026/07/17/) — v4 beta status
