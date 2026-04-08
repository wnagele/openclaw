---
title: "plan: Replace the embedded PI agent harness with Codex app-server"
type: plan
status: active
date: 2026-04-08
---

# plan: Replace the embedded PI agent harness with Codex app-server

## Summary

Replace the embedded PI execution engine incrementally, not the whole OpenClaw
agent stack in one move.

The safe cut point is below `runEmbeddedPiAgent` and above PI's
`createAgentSession` call:

- keep `src/agents/pi-embedded.ts` exports stable
- keep `src/agents/pi-embedded-runner/run.ts` orchestration first
- add a Codex app-server attempt backend beside
  `src/agents/pi-embedded-runner/run/attempt.ts`
- preserve `RunEmbeddedPiAgentParams` and `EmbeddedPiRunResult`
- keep the current PI backend as fallback until parity is proven

This keeps the broad caller surface intact while replacing the highest-churn
agent harness internals.

Implementation status on `app-server`:

- `runEmbeddedPiAgent` now calls an internal backend selector.
- `OPENCLAW_AGENT_RUNTIME=codex-app-server` forces the Codex app-server backend.
- `OPENCLAW_AGENT_RUNTIME=auto` tries app-server for `openai-codex` and falls
  back to PI if app-server fails.
- default remains `pi`.
- the app-server backend has a long-lived stdio JSON-RPC client, thread sidecar
  binding, turn start/interrupt/steer wiring, event projection, and dynamic
  OpenClaw tool bridging.
- guardian review notifications are projected as diagnostic agent events only.

## Goal

Use `codex app-server` for the core agent execution path without losing the
OpenClaw behaviors that users notice:

- session resume
- in-flight queueing and steering
- abort and restart behavior
- channel-aware replies
- reasoning and plan streaming
- message/subagent/cron/plugin tools
- compaction and context pressure recovery
- session metadata and token/cost reporting
- command/file approval policy
- eventual guardian-backed approval review

## Non-Goals

- Do not replace CLI backends in the first slice.
- Do not remove the PI runner until app-server parity is measured.
- Do not force all model providers through app-server on day one.
- Do not move channel, plugin, or session-store code just to make the first
  backend work.
- Do not expose app-server protocol details to channel/plugin code.
- Do not depend on the experimental websocket transport for production.

## Current Shape

`src/agents/pi-embedded.ts` is a narrow barrel. It exports the public functions
and types used by the rest of OpenClaw:

- `runEmbeddedPiAgent`
- `queueEmbeddedPiMessage`
- `abortEmbeddedPiRun`
- `compactEmbeddedPiSession`
- active-run checks and wait helpers
- `EmbeddedPiRunResult` and related metadata types

Most callers should not know whether PI or Codex app-server executes a turn.

`src/agents/command/attempt-execution.ts` is the main user-run entrypoint. It
selects the CLI backend for CLI providers, otherwise calls `runEmbeddedPiAgent`
with channel routing, session identity, model/profile settings, workspace,
skills, images, callbacks, and abort state.

`src/agents/pi-embedded-runner/run.ts` does important OpenClaw orchestration:

- session key backfill
- global and per-session lanes
- workspace resolution
- runtime plugin loading
- model/provider resolution
- auth profile order and cooldown handling
- fallback and retry policy
- context engine setup and maintenance
- compaction side effects
- timeout and overflow recovery
- result payload building
- token usage accumulation
- model switch handling

This is too much to throw away in a first pass.

`src/agents/pi-embedded-runner/run/attempt.ts` is the heavy PI-specific layer.
It creates PI sessions, builds PI tools, opens the PI session manager, submits
the prompt, subscribes to PI events, handles active-run steering, and deals with
PI transcript/compaction details.

That is the best first replacement target.

## Why Not Replace `pi-embedded.ts` Directly

Replacing the barrel would force every downstream caller to absorb app-server
semantics at once. That risks breaking behavior spread across:

- auto reply command execution
- gateway session control
- subagent spawning and follow-up
- queue modes
- cron and heartbeat runs
- tests that assert PI-shaped metadata

Keeping the public barrel stable lets the migration behave like a backend swap,
not a public agent API migration.

## Proposed Architecture

Add an internal execution backend seam:

```ts
type EmbeddedAgentAttemptBackend = {
  id: "pi" | "codex-app-server";
  runAttempt(params: EmbeddedAgentAttemptParams): Promise<EmbeddedAgentAttemptResult>;
};
```

The exact type names can be local to `src/agents/pi-embedded-runner/run.ts`.
The contract should use the existing attempt/result data already returned by
`runEmbeddedAttempt` rather than leaking Codex protocol types upward.

Initial module layout:

- `src/agents/codex-app-server-runner/client.ts`
  JSON-RPC stdio client, initialize/initialized handshake, request id routing,
  notification dispatch, server-initiated request handling.
- `src/agents/codex-app-server-runner/protocol.ts`
  Hand-curated local subset of the generated app-server protocol. Refresh
  against `codex app-server generate-ts --experimental` when app-server changes.
- `src/agents/codex-app-server-runner/session-binding.ts`
  Map OpenClaw session files to Codex thread ids through a sidecar file.
- `src/agents/codex-app-server-runner/event-projector.ts`
  Convert app-server events into OpenClaw callbacks and final result state.
- `src/agents/codex-app-server-runner/dynamic-tools.ts`
  Convert OpenClaw tool definitions into app-server dynamic tools.
- `src/agents/codex-app-server-runner/run-attempt.ts`
  Codex app-server backend implementation.

Keep app-server-specific imports out of channel/plugin code.

## Runtime Process Model

Prefer one long-lived app-server child process per OpenClaw gateway process.

Reasons:

- app-server already multiplexes threads
- one process keeps model/config discovery warm
- session resume maps naturally to app-server threads
- process restart can be handled by reinitializing and resuming known threads

MVP fallback: one app-server process per run or per session is acceptable only
for early smoke tests. It should not become the long-term design because it
wastes startup time and makes thread lifecycle harder to reason about.

Transport:

- use stdio JSONL: `codex app-server --listen stdio://`
- do not use websocket in production yet; app-server marks it experimental and
  unsupported
- initialize with `clientInfo.name = "openclaw"`
- set `capabilities.experimentalApi = true` only when dynamic tools or guardian
  telemetry are enabled

## Session Binding

First implementation uses a sidecar binding next to the PI session file:

```txt
<sessionFile>.codex-app-server.json
```

This avoids changing `SessionEntry` and the session-store contract while the
backend is still feature-flagged.

Longer term, move the binding into `SessionEntry`.

Recommended first shape:

```ts
export type SessionCodexAppServerBinding = {
  threadId: string;
  cwd?: string;
  model?: string;
  modelProvider?: string;
  codexHome?: string;
  createdAt: number;
  updatedAt: number;
  schemaVersion: 1;
};
```

Then:

```ts
export type SessionEntry = {
  // existing fields...
  codexAppServer?: SessionCodexAppServerBinding;
};
```

Do not overload `cliSessionBindings`. CLI session ids, ACP runtime metadata, and
Codex app-server thread ids have different lifecycle semantics.

OpenClaw mirrors the minimal user/assistant turn back into the existing PI
JSONL transcript so session views, cost readers, and transcript-indexing hooks
still see the Codex app-server path.

## App-Server Protocol Mapping

Thread lifecycle:

- no binding: call `thread/start`
- existing binding: call `thread/resume`
- `/new` or reset: clear the binding and create a new thread
- branch/fork support: defer until core resume is stable

Turn lifecycle:

- user prompt and images: `turn/start`
- queued in-flight user text: `turn/steer`
- abort: `turn/interrupt`
- manual compaction: `thread/compact/start`
- shell command outside agent turn: do not use initially

Turn input:

- text prompt -> `{ type: "text", text }`
- remote image URL -> `{ type: "image", url }`
- local screenshot/file image -> `{ type: "localImage", path }`
- skills can later use app-server skill input items, but MVP should preserve
  OpenClaw's existing skills prompt snapshot to avoid a second migration.

Config mapping:

- `workspaceDir` -> `cwd`
- `model` -> app-server `model`
- OpenClaw provider -> app-server `modelProvider` only for providers app-server
  actually supports
- `thinkLevel` / `reasoningLevel` -> `effort` where possible
- approval policy -> app-server `approvalPolicy`
- sandbox config -> app-server `sandbox` on thread start and `sandboxPolicy` on
  turn start
- channel/runtime instructions -> `developerInstructions` or turn input wrapper,
  not a replacement for Codex base instructions

## Event Projection

Create an event projector that owns all app-server to OpenClaw conversion.

Minimum mappings:

| App-server event                       | OpenClaw behavior                 |
| -------------------------------------- | --------------------------------- |
| `turn/started`                         | lifecycle event, active run state |
| `item/agentMessage/delta`              | partial reply/block reply stream  |
| `item/completed` for `agentMessage`    | final assistant text              |
| `item/reasoning/summaryTextDelta`      | `onReasoningStream`               |
| `item/reasoning/textDelta`             | optional raw reasoning stream     |
| `item/plan/delta`                      | plan event stream                 |
| `item/started` tool/command/file/MCP   | tool/status event                 |
| `item/completed` tool/command/file/MCP | tool result/status event          |
| `item/commandExecution/outputDelta`    | command output event              |
| `item/fileChange/outputDelta`          | file edit output event            |
| `turn/completed`                       | final `EmbeddedPiRunResult`       |
| `thread/status/changed`                | diagnostic/lifecycle event        |
| `contextCompaction` item               | compaction count/status           |
| guardian review notifications          | best-effort approval telemetry    |

The projector should return the same data the PI subscription layer currently
extracts:

- assistant texts
- reasoning texts
- tool summaries
- usage totals when available
- compaction count
- message-tool side effects
- cron additions
- final stop reason
- abort/error state

Do not reuse `subscribeEmbeddedPiSession` directly. It expects PI
`AgentSession` events. Reuse smaller helpers from the PI subscription layer only
when they are protocol-independent.

## Active Run Mapping

Keep `src/agents/pi-embedded-runner/runs.ts`.

The app-server backend registers an `EmbeddedPiQueueHandle`:

- `queueMessage(text)` -> `turn/steer`
- `abort()` -> `turn/interrupt`
- `isStreaming()` -> current app-server turn state
- `isCompacting()` -> app-server compaction state
- `cancel(reason)` -> local cancellation plus app-server interrupt

This preserves `queueEmbeddedPiMessage`, `abortEmbeddedPiRun`,
`isEmbeddedPiRunActive`, and `waitForEmbeddedPiRunEnd` for existing callers.

## Tool Strategy

Use two phases.

### Phase 1: Native Codex Tools

Use Codex app-server's native tool stack first:

- shell
- file reads/writes
- apply patch
- plan/reasoning
- MCP, if already configured in Codex

This gets the runner alive with low glue code.

Missing in this phase:

- OpenClaw channel message tools
- `sessions_send` / subagent tools
- cron tools
- OpenClaw plugin tools
- channel-specific action/reaction tools
- OpenClaw tool policy accounting

This phase must stay feature-flagged and limited to manual testing.

### Phase 2: Dynamic OpenClaw Tools

Bridge OpenClaw tools through app-server dynamic tools.

Use `createOpenClawCodingTools` as the source of truth. That keeps existing
tool policy, group/owner restrictions, plugin tools, abort signals, and
message-tool side effects in one place.

Bridge flow:

1. Build OpenClaw tools for the current run context.
2. Convert each safe schema to app-server `DynamicToolSpec`.
3. Register dynamic tools on `thread/start`.
4. Handle app-server `item/tool/call` requests.
5. Invoke the OpenClaw tool implementation.
6. Return app-server content items:
   - `{ type: "inputText", text }`
   - `{ type: "inputImage", imageUrl }`
7. Record OpenClaw side effects for final `EmbeddedPiRunResult`.

Important caveat: app-server dynamic tool responses are text/image content
items. Some OpenClaw tools have richer side effects. The bridge must keep those
side effects in OpenClaw state, then return a concise text summary to Codex.

Start with a narrow dynamic-tool allowlist:

- channel message send tools
- `sessions_send`
- subagent spawn/control tools
- cron add/list/remove tools

Expand after the event projector and side-effect accounting are stable.

## Guardian and Approvals

Codex app-server has two relevant approval modes:

- `approvalsReviewer: "user"`
- `approvalsReviewer: "guardian_subagent"`

Use guardian only on the Codex-native approval path at first. App-server marks
guardian review notifications as unstable, so OpenClaw should treat them as
diagnostic/status data, not a stable persisted contract.

Approval handling rules:

- if `approvalPolicy` is never/no-approval, no client approval UI needed
- if app-server asks OpenClaw for command/file/network approval and guardian is
  disabled, fail closed until OpenClaw has a real approval surface for that
  request kind
- if guardian is enabled, let app-server make the review decision and project
  guardian status to `onAgentEvent`
- never auto-accept app-server approval requests just because OpenClaw allowed
  a similar PI tool before

OpenClaw currently has no equivalent core agent guardian implementation. The
repo's `guardian` references are unrelated platform/UI code or prose examples.

## Feature Flags

Add a runtime selector with a conservative default:

- `OPENCLAW_AGENT_RUNTIME=pi`
- `OPENCLAW_AGENT_RUNTIME=codex-app-server`
- `OPENCLAW_AGENT_RUNTIME=auto`

Default: `pi`.

`auto` should only choose app-server when all of these are true:

- selected provider is `openai-codex`
- app-server initializes successfully
- dynamic tool bridge is enabled through the thread-start dynamic tool list

Add a config key later only after the env flag proves useful.

## Rollout Slices

### Slice 0: Protocol Client and Tests

- Add local protocol subset.
- Add stdio JSON-RPC client.
- Cover selector, event projection, and session binding.

Done in the first implementation.

### Slice 1: Text-Only App-Server Attempt

- Add backend seam under `runEmbeddedPiAgent`.
- Implement `codex-app-server` backend with text prompt, no dynamic tools.
- Use `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`.
- Project assistant text, reasoning summary, plan, and turn completion.
- Return `EmbeddedPiRunResult`.
- Keep PI fallback and default.

Manual smoke: one workspace, one prompt, no channel send tools.

Done with dynamic tools included.

### Slice 2: Session Binding and Transcript Mirror

- Add `SessionCodexAppServerBinding`.
- Persist thread ids in a sidecar file first.
- Mirror minimal user/assistant transcript to existing `sessionFile`.
- Clear binding on reset.
- Verify resume and `/new`.

Done: sidecar thread persistence, minimal transcript mirror, and reset-aware
binding clearing.

### Slice 3: Active Run Controls

- Register app-server active run handle.
- Map queueing to `turn/steer`.
- Map abort/restart to `turn/interrupt`.
- Preserve `waitForEmbeddedPiRunEnd`.
- Add tests for queue/abort state.

Done with targeted queue and abort coverage.

### Slice 4: Event Projector Parity

- Add status projection for command/file/MCP/dynamic tools.
- Add reasoning end handling.
- Add compaction count/status.
- Add usage extraction when app-server provides token usage.
- Mark `totalTokensFresh=false` when usage is unavailable or not comparable.

### Slice 5: Message and Subagent Tools

- Enable dynamic tools experimentally.
- Bridge message tools and sessions/subagent tools first.
- Preserve `didSendViaMessagingTool` suppression.
- Preserve sent text/media/target metadata.
- Add cron count support.

### Slice 6: Compaction and Overflow

- Support `compactEmbeddedPiSession` via `thread/compact/start`.
- Map context overflow errors to existing failover/compaction flow where
  possible.
- Decide which PI-specific tool-result truncation paths still apply.

Manual compaction is wired through `thread/compact/start` when a Codex
app-server thread binding exists. Overflow-specific recovery remains partial
because app-server owns the native Codex history and exposes fewer PI-style
transcript repair hooks.

### Slice 7: Default-On for Codex Provider

- Use app-server automatically for the Codex provider.
- Keep PI for non-Codex providers.
- Keep env/config kill switch.
- Add docs and release note only when user-facing behavior changes.

Done: default runtime resolution is `auto`, which routes `openai-codex` attempts
through app-server and falls back to PI on startup/runtime failure. Set
`OPENCLAW_AGENT_RUNTIME=pi` to force the legacy PI backend.

### Slice 8: Retire PI from Codex Path

- Remove PI session manager usage from the Codex provider path.
- Keep PI dependency only for providers/features still using it.
- Later decide whether to replace non-Codex provider execution or keep PI as a
  compatibility backend.

## Feature Parity Matrix

| Behavior                  | MVP        | Dynamic bridge | Notes                                     |
| ------------------------- | ---------- | -------------- | ----------------------------------------- |
| text replies              | yes        | yes            | app-server native                         |
| reasoning stream          | yes        | yes            | map summary deltas first                  |
| plan stream               | yes        | yes            | app-server plan item                      |
| command/file tools        | yes        | yes            | Codex native first                        |
| channel message tools     | no         | yes            | OpenClaw dynamic bridge                   |
| subagents/session tools   | no         | yes            | OpenClaw dynamic bridge                   |
| cron tools                | no         | yes            | OpenClaw dynamic bridge                   |
| plugin tools              | no         | later          | depends on schema compatibility           |
| queue steer               | yes        | yes            | `turn/steer`                              |
| abort                     | yes        | yes            | `turn/interrupt`                          |
| compaction                | yes        | yes            | `thread/compact/start`                    |
| model fallback            | partial    | partial        | keep PI orchestration; Codex auth differs |
| auth profile rotation     | no         | no             | app-server owns Codex auth                |
| prompt cache metrics      | partial    | partial        | use app-server usage if exposed           |
| session transcript repair | not needed | not needed     | do not port PI repair blindly             |
| guardian                  | partial    | partial        | unstable telemetry                        |

## Risks

### Tool Semantics Drift

Codex native tools and OpenClaw PI tools are not the same contract. Message,
subagent, cron, channel, and plugin tools must be bridged deliberately rather
than assumed.

Mitigation: keep app-server default off until dynamic tool side effects match
`EmbeddedPiRunResult`.

### Auth and Provider Drift

OpenClaw auth profiles and provider fallback were built around PI/provider
adapters. App-server uses Codex config/auth.

Mitigation: first support only the Codex provider. Keep PI for non-Codex
providers and for auth-profile rotation.

### Session History Split Brain

App-server has threads; OpenClaw has session files and session store metadata.

Mitigation: persist explicit Codex thread bindings and mirror minimal transcript
data until UI/history code can consume app-server thread history directly.

### Experimental APIs

Dynamic tools and guardian telemetry require app-server experimental API opt-in.

Mitigation: isolate protocol handling in one module, parse unstable guardian
events permissively, and make dynamic tools separately flaggable.

### Compaction Mismatch

PI compaction and app-server compaction are different systems.

Mitigation: do not reuse PI transcript mutation logic on app-server threads.
Map only user-facing compaction state and token metadata first.

## Test Plan

Unit tests:

- JSON-RPC client initializes and rejects pre-initialize calls.
- fake app-server emits text/reasoning/plan/tool/turn completion events.
- event projector builds `EmbeddedPiRunResult`.
- session binding persists and clears thread ids.
- active run handle queues via `turn/steer`.
- active run handle aborts via `turn/interrupt`.
- dynamic tool bridge maps a message tool side effect.
- approval requests fail closed when unhandled.
- guardian telemetry is accepted but non-fatal.

Targeted test commands:

```sh
pnpm test src/agents/pi-embedded-runner/runs.test.ts
pnpm test src/agents/command/attempt-execution.test.ts
pnpm test src/agents/codex-app-server-runner
```

Build gate:

```sh
pnpm build
```

Build is required because this touches lazy/module boundaries and generated
protocol imports.

Manual smoke:

```sh
OPENCLAW_AGENT_RUNTIME=codex-app-server pnpm openclaw ...
```

Smoke cases:

- text-only direct session
- resumed session
- queued follow-up while streaming
- abort while command is running
- manual compaction
- channel send through dynamic message tool
- subagent spawn and follow-up

## Implementation Order

1. Add protocol client and fake server tests.
2. Add backend selector, defaulting to PI.
3. Implement text-only app-server backend.
4. Add event projector for assistant/reasoning/plan/turn completion.
5. Add session binding and transcript mirror.
6. Add active run steer/abort.
7. Add dynamic message/subagent/cron tools.
8. Add compaction mapping.
9. Enable `auto` for Codex provider behind kill switch.
10. Measure parity, then remove PI from Codex-only execution path.

## Decision

Proceed with a backend seam under `runEmbeddedPiAgent`, not a direct replacement
of `src/agents/pi-embedded.ts`.

The first production-safe milestone is:

- app-server backend exists
- default remains PI
- Codex provider can opt in with env flag
- text/reasoning/plan streaming works
- resume, abort, and steer work
- transcript mirror is written
- PI fallback remains available

Only after message/subagent/cron tools work through dynamic tools should the
Codex provider move toward default-on app-server execution.
