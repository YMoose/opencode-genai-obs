# TODO / Roadmap

Future directions, not commitments. Traces are the current focus — nothing here affects
the tracing path.

## Semconv gaps confirmed by source audit

See `docs/source-audit.md` for checked versions and relative source paths. These are runtime
follow-ups; the documentation correction does not change emitted data or frozen ID formulas.

- Cache writes currently emit `gen_ai.usage.cache_write.input_tokens`; the checked standard
  name is `gen_ai.usage.cache_creation.input_tokens`. Review compatibility before migrating.
- `gen_ai.response.finish_reasons` is currently a JSON string. Standard typing is `string[]`,
  which requires widening `AttrValue` and verifying actual OTLP encoding with a regression test.
- `gen_ai.response.model` duplicates the requested model; use independently observed response
  identity when available rather than implying that the duplicate is a provider observation.
- Chat duration includes step settlement. Evaluate `session.step.streamed` and request-start
  timing before presenting this as model-request latency.
- Truncating JSON-valued attributes can break their JSON/schema validity. Define an explicit
  representation for oversized structured content before changing the truncation path.
- Legacy message-event names are deprecated; plan any migration separately from retaining
  current backend compatibility.

## Standing heuristics (labeled)

Standing semantic heuristics approved per the AGENTS.md "Heuristic policy" (upstream
contracts come first): each is labeled `HEURISTIC(upstream-gap)` where it lives in
`src/spans.ts`. These are governing records, not roadmap items — a heuristic is retired
only when its migration condition is met (and the compaction one is id-frozen, see below).

| Site (path:line) | Invented semantics | Upstream gap | Upstream issue | Migration condition | Approved |
| --- | --- | --- | --- | --- | --- |
| `src/spans.ts:198` | Compaction run identity = the started event's ms timestamp (`CompactionState.key`) | `session.compaction.started/ended` carry only {sessionID, reason}; ended never references its started; no run id exists. Key is FROZEN — it feeds the `opencode-compaction:<sid>:<created>` id formulas, so changing it changes all future span ids | — | Upstream adds a run/correlation id (any key change before that needs an explicit id-continuity decision) | user decision 2026-11-01; adjudicated keep — user decision 2026-11-02 |
| `src/spans.ts:634` | Turn identity only: turn root keyed `auto:<created>` when `step.started` arrives with no stashed prompt. The fabricated user message `"(auto)"` and its four attribution leaks (`gen_ai.user.message` log event, `input.value`, name preview, `opencode.user_prompt.length` = 6) were REMOVED in Bug 25 — wakeup text now comes from the real synthetic events, and the turn root carries `opencode.turn.wakeup` = `synthetic`/`unknown` | No marker ties an execution round to its wakeup: the round-opening `step.started` carries no origin. The synthetic events DO fire (v2 source + live probe `/tmp/opencode/syn-probe.jsonl`): subagent-completion wakeup (synthetic `session.inbox.enqueued` item), `Session.synthetic` external route, restart continuation (`restart.ts:93`), instruction injection (`instructions.ts:75`), stream continuation (`llm.ts:333,364`). The earlier "never fires" claim (2026-11-01 probe) was a probe artifact — those paths were not exercised | [#47701](https://github.com/anomalyco/opencode/issues/47701) | Upstream documents a round-origin marker correlating `step.started` with its wakeup event | user decision 2026-11-01 (turn identity); attribution fabrication removed in Bug 25 — mechanism-aligned, real events consumed |
| `src/spans.ts:354` | "An interrupted step may still deliver a late `step.ended`" — mark-not-delete design (`interrupted` flag) rested on it. Adjudicated 2026-11-03: assumption REFUTED for live ordering — upstream publishes step terminals inside an uninterruptible block (`runner/step.ts:140-283`, `Step.Ended` at `:247-258`) and `execution.interrupted` only afterwards, from the coordinator's settled hook (`execution.ts:129-133`, `run-coordinator.ts:96-100`), so live `step.ended` ALWAYS precedes interrupted; the sole no-terminal interrupt path is cancellation before the assistant started (`step.ts:147-148`) — the mark branch never fires in live operation | No documented delivery contract for step terminals relative to `session.execution.interrupted`; source ordering now verified as above | — | None for live; retire the mark branch only by explicit user decision | user decision 2026-11-01; adjudicated keep — user decision 2026-11-03 (retained as cheap gap/replay defense: bounded ~20 lines, tested, no live-path branching cost beyond the dual-mode purge; a consciously-accepted exception to AGENTS.md "live capture first") |
| `src/spans.ts:913` | Reasoning segments concatenate in ARRIVAL order; never a fabricated interleaving with text parts. Adjudicated 2026-11-03: live ordering VERIFIED — the bus preserves per-subscription publish order (`bus.ts:751-782`), so in live capture arrival order equals generation order; the no-ordinal gap matters only for replay lanes | Text segments carry a protocol ordinal; reasoning events carry no ordinal/index — concatenation order has no contract guarantee (live delivery verified ordered; replay lanes still unguaranteed) | — | Upstream adds an index to reasoning segments | user decision 2026-11-01; adjudicated keep — user decision 2026-11-03 |

Known limitation (heuristic #1, verified 2026-11-02): the compaction run registry is
in-memory single-open-run state, so a plugin restart between `session.compaction.started`
and `session.compaction.ended/failed` finds no run to pair with — the terminal handler
returns before emitting (`src/spans.ts:717`), dropping the span entirely, not degraded:
the ended event's model/tokens/cost/text reach no span (a bare reason+start-time span
only ever comes from a recorded start, via predecessor flush or graceful `flushAll`).
Upstream ask: compaction started/ended carry no run id and ended does not reference its
started — candidate [#47701](https://github.com/anomalyco/opencode/issues/47701)
follow-up material (external post requires user approval).

Known limitation (Bug 23 guard boundaries, accepted 2026-11-03): two behaviors of the
durable.seq stale-terminal guard are accepted as-is — both upstream gaps (no round id in
the event envelope). First, a stale old-round terminal's error payload is discarded by
design: the guard (`src/spans.ts:559`) mutates nothing, so the superseded round's failure
reason never lands on any span; surfacing it would require an upstream round
discriminator. Second, the no-seq degrade path: when `durable.seq` is absent (older
hosts), a late terminal still flushes the current turn early and the new round's chat span
is lost — pinned by the Bug 23 fallback test (`tests/spans.test.ts:838`) as the documented
pre-Bug-23 behavior.

Known limitation (S4, record-only per user decision 2026-11-03): a `session.renamed`
arriving before the session is registered — plugin mid-attach (missed `session.created`)
or post-eviction — is dropped from the sessions registry: the guard (`src/spans.ts:588`)
only mutates cached state. Recovery: the turn/container flush refreshes the title live
via `getSessionInfo` (`ctx.session.get` returns the post-rename title), and the
annotation lane uses the event data directly. Residual risk (accepted, record-only):
the title is missing ONLY when mid-attach + rename + flush-time `ctx.session.get`
failure coincide — the name falls back to the prompt preview/`"(empty)"`; degraded,
never wrong data. Rationale: live-capture-first principle — a stash table for this
triple coincidence is not worth main-path complexity.

Known limitation (Bug 32 accounting semantics, accepted 2026-11-03): in-flight tool
state is retained across round close with a round-bound `traceId` (`ToolState.traceId`,
stamped at creation and backfilled at round close before the flush), so a late tool
terminal emits with its original name/duration/attribution — but the round's
already-flushed `opencode.turn.messages` cannot retroactively count it (the turn root
is a snapshot at flush time), and a late old-round terminal never counts on the newer
round's root (traceId-guarded accounting). Unload `flushAll` emits unsettled tools as
`interrupted: plugin_unload` and counts each on its own still-open turn's root; the
registry is bounded by MAX_IN_FLIGHT_TOOLS (1024, oldest-first eviction, degraded
terminal for the evicted call — never a fabricated span).

Candidate Bug 33 (deferred, record-only per user decision 2026-11-03): a redelivered
`session.tool.input.started` / `session.tool.called` for a callId whose terminal already
emitted re-creates the ToolState (`src/spans.ts:764-803` — no `endedTools` check at
re-creation; `:770` `prior` only preserves an entry that still exists) stamped with the
CURRENT round's live traceId (`:776`). The redelivery's own terminal is correctly ignored
(`:811-814`), but since Bug 32 retention keeps tool state across round closes, the zombie
ToolState survives and at unload emits a phantom `interrupted: plugin_unload` span under
the WRONG round's trace and inflates that turn's `opencode.turn.messages`
(`src/spans.ts:1233-1250`). Precondition: at-least-once redelivery of a tool start after
its terminal (the Bug 13/16/17 class; not observed live). Fix when undertaken: an
`endedTools` guard at re-creation entry. Replay-only variant: `stampInFlightTools` stamps
by session (`src/spans.ts:426-430`), so an unstamped old-round tool can inherit the next
round's trace.

Audit item ① adjudicated (user decision, option B, 2026-11-03):
`opencode.interrupt.reason` is host-enum-only; unload teardown does not set it (the
`plugin_unload` cause stays in the status message) — Bug 34.

## Governance log

- 2026-11-01: Full-project review surfaced 10 bugs (Bugs 16-22 fixed red-first) and a
  governance gap → heuristic policy adopted in AGENTS.md (`2be1436`): no invented
  identity/ordering/attribution without an explicit user decision; standing heuristics
  must be labeled. Four standing heuristics labeled in code (`HEURISTIC(upstream-gap)`
  ×4, `6203b46`) and indexed here.
- Bug 23 (`0bd2f48`) set the pattern: a proposed heuristic fix (timestamp guard /
  superseded-reason routing) was retracted in favor of the upstream mechanism
  (durable.seq) once the contract was verified.
- 2026-11-03: "Live capture first" principle — live capture is primary; no live-path
  complexity for replay-only anomalies (AGENTS.md, `3776970`).
- Bug 32 (2026-11-03): late/unload-race tool terminal loss — in-flight tool state is
  retained across round close with a round-bound traceId (name/duration/attribution
  survive late terminals and round takeovers); round accounting is traceId-guarded so
  an old-round terminal never inflates the current round; unload flushAll emits
  in-flight tools as `interrupted: plugin_unload` (closes the measured host-restart
  window: plugin "unloaded" → parent tool settles 17ms later, span previously lost).
- One-by-one adjudication of all four standing heuristics, each grounded in upstream
  source verification (`~/yzh/code/temp/opencode`; upstream citations verified against
  v2.2.5) and live probes:
  - #1 compaction timestamp identity — KEEP; restart limitation recorded (`4e2737e`);
    adjacent hazard fixed as Bug 24 (`3420b7c`, durable.seq guard).
  - #2 auto-turn fabricated attribution — REMOVED; real wakeup events consumed
    (`opencode.turn.wakeup`, Bug 25 `51875d8`) + stale-wake hardening (Bug 26
    `e221669`); S2 closed.
  - #3 interrupted-step marking — KEEP, zero code change; assumption verified against
    upstream ordering, retained as an accepted gap/replay exception (`ba89f60`).
  - #4 reasoning arrival-order — KEEP, zero change; live ordering verified (`ba89f60`).
- Closing pattern: policy → labels → per-item adjudication → every outcome is either a
  mechanism-aligned fix or a verified archive entry; nothing stays a guess.

## Offline session replay lane (promised, not yet implemented)

`src/ids.ts` declares a FROZEN deterministic-id contract whose counterpart is "an
internal offline replay lane" that replays exported opencode session dumps
(`~/exports/*.json` + `.manifest.json` signatures) into the same OTLP pipeline, with
byte-identical span/trace ids so backend dedup collapses real-time and replayed copies
of the same turn. **The lane does not exist in this workspace yet** — when it gets
built, it must re-derive the current semantics, not the ones at first writing:

- **Bug 13 idempotency**: replay must dedup terminal step events per assistantMessageID
  (the `endedSteps` semantics in `src/spans.ts`) — exported transcripts can contain
  duplicate `step.ended` fan-out artifacts.
- **Ordinal-ordered text reassembly**: `output.value` is `text.ended` segments sorted
  by protocol `ordinal`, joined with `\n\n` — not arrival order.
- **Bug 32 tool round-binding**: each tool's `ToolState` freezes its round's traceId at
  creation (`input.started`/`called`) or at round close (stamp before the flush); a tool
  terminal arriving after the round closed emits under the stamped trace — never the
  currently-open round's — and counts on a turn root only when the traceIds match.
  Unload `flushAll` emits unsettled tools as `interrupted: plugin_unload`.
- **Billable-input token math**: `gen_ai.usage.input_tokens` and the
  `gen_ai.client.token.usage` input type both include cache read + cache write
  (separate `gen_ai.usage.cache_read/write.input_tokens` attributes carry the split).
- **Truncation semantics**: `contentMaxLength` sentinel chain (-1 = full, 0 = metadata
  only, N>0 = N-byte retained prefix plus `[TRUNCATED original_length=<original bytes>]` marker) applies equally
  to replayed content.
- **Signal surface**: traces are the point; metrics/logs lanes stay optional (the
  replay host may have no metrics backend). Wire frames are absent in replay — the
  `gen_ai.system.message` event simply doesn't fire.
- The id formulas themselves (`opencode-turn/chat/tool` prefixes, byte lengths) are
  frozen by `tests/ids.test.ts`; the replay lane reads them from `src/ids.ts` verbatim.

## Prompt source recon: `prompt` hook vs `session.inbox.enqueued`

We capture prompts via the `prompt` session hook; DEVtheOPS uses the
`session.inbox.enqueued` event instead. Not a migration candidate today — the hook's
`messageID` feeds the FROZEN `turnTraceId` formula, and the event's `inboxID` is not
verified to be the same value (a silent id-scheme change would break offline-replay
dedup). Recon needed before any reconsideration: (a) does `inboxID` equal the chat
message id byte-for-byte, (b) does the `prompt` hook fire for non-TUI-driven sessions
(server API / `opencode run`), or does the event catch prompts the hook misses.

## Event coverage: skills / permissions / usage / non-session namespaces

The SSE pump currently filters to `session.*` events only, but `ctx.event.subscribe()`
exposes the full event namespace. Known gaps, all actionable today (verified against the
v2 schema in `packages/schema/src/session-event.ts`):

- `session.skill.activated` (skill id/name/text) — exists in the stream, not handled
- `session.permissions` (ruleset changes) — exists, not handled
- `session.usage.updated` (rolling cost totals) — exists, not handled
- Non-session namespaces: `permission.*` (request/decision pairing — wait-duration
  metric if the decision event is actually pushed), `mcp.*` (connection lifecycle)
- Not currently captured here (upstream support must be checked per item):
  raw provider response-body capture in this plugin, transport-level detail (status codes, SDK retries),
  complete model-request terminal-state distinctions (refused / cancelled / retries-exhausted),
  structured MCP server attribution on tool events, plugin/skill load lifecycle,
  session-level end events

## Rejected tool-call attribution (attempted vs executed audit)

A guardrail plugin can veto a tool call before it runs by throwing from the
`execute.before` hook (v2 semantics, per opencode #51230 / #52837): the command never
executes and the error text becomes the tool result handed back to the model. In our
data that lands as an ordinary failed tool span — indistinguishable from a real
execution error unless you pattern-match the error text. #51230's "attempted vs
executed" audit trail is exactly this gap, covered by neither built-in OTel (internal
Effect spans only) nor us.

- Structural signal, verified in v2 source: `execute.before` runs inside the tool's
  execute (core `tool.ts`), and `execute.after` fires only on the real execution path
  — so "terminal `session.tool.failed` with no matching `execute.after` firing"
  identifies a pre-execution rejection without guessing at error text.
- Implementation shape: a read-only `ctx.tool.hook("execute.after")` observer
  (correlate by tool call id — a Set of seen ids, kept off the hot path), then stamp
  the failed tool span (e.g. `opencode.tool.rejected: true`; the rejection reason is
  already in `error.type`/message). Permission denies likely surface via the
  `permission.*` namespace instead — overlaps the Event coverage section above.
- This would be our third input channel (SSE pump, ws.send/http.request wire hooks,
  tool hooks): keep it strictly observe-only — never throw from our hooks, or we
  become a guardrail ourselves.

## Per-project / per-session config overrides

Config is global today: one file drives every location and session in the process.
Targeted configuration would scope behavior to specific projects or sessions:

- Use cases: route a work project's spans to the company collector while personal
  projects stay local (or off); exclude noisy sessions (subagent fan-outs,
  title/compaction traffic); tighten content gates for sensitive projects only.
- Rough shape: layered overrides — global defaults < per-project entry (matched by
  the session's directory, known at session registration) < per-session rules.
  Overrides should probably be limited to a safe subset (endpoint / headers /
  content gates / wire settings): the id scheme and turn semantics must stay global
  to keep deterministic-id dedup intact.
- Per-session by ID is awkward (IDs are dynamic); filters by agent / kind / parent
  (sub-agent) likely cover the real need. Per-agent overrides may subsume most of it.
- Open questions: resolution timing (session start vs hot reload), and how the
  override layers stack against env-driven org-wide settings (env should stay top).

## Per-tool capture scoping

`contentGates.toolDetails` / `toolContent` currently gate tool-call capture uniformly
across every tool. A per-tool scope would select which tools' arguments/results land on
tool spans at all:

- Use cases: privacy (bash command lines are the sensitive surface — capture only those,
  or exclude them); volume (read/glob results dominate span bytes); focused analysis
  (downstream file-set reconstruction only needs bash + edit).
- Config sketch: `tracing.contentGates.toolScope: { "include": ["bash", "edit"] }` or
  `{ "exclude": ["read"] }`, intersected with the domain gates — a tool call must pass
  both the scope and `toolDetails`/`toolContent` to be captured.
- Matching needs a story for MCP tool names (namespaced, e.g. `mcp__server__tool`):
  exact names plus `prefix:*` globs are the likely shape.
- Scope: span attributes only; the wire JSONL stays all-or-nothing (it is the request
  body, not per-tool telemetry).

## TUI sidebar status indicator

A small sidebar presence like omo-slim's — an activity indicator while a turn is being
traced/sent, backend connectivity, queue depth, spans sent/dropped counters.

- Mechanism (per omo-slim recon): v2 sidebar surfaces are companion panes rendered with
  OpenTUI (`@opentui/core` + `@opentui/solid`); omo-slim ships a companion client
  (manifest + manager + updater) with golden-frame tests pinning pixel output. That is
  the established pattern — and a separate deliverable much heavier than this
  in-process, zero-UI plugin.
- The plugin already holds everything worth showing in memory (pipeline owner/realms,
  spans emitted/queued/dropped, OTLP send latency, wire frame counts); a companion
  would need an IPC surface to read it (status file vs localhost socket — to be sized).
- Lighter alternative to watch: upstream [#46156](https://github.com/anomalyco/opencode/issues/46156)
  (reserved plugin dataflow panel in core) would remove the need for our own pane.

## OTLP logs/events export — DONE

Shipped: metrics (gen_ai.client.token.usage + gen_ai.client.operation.duration) and the
opt-in logs lane (gen_ai.user.message / system.message / tool.message / choice;
historical assistant-input events are not emitted; these event names are deprecated). Every event carries the deterministic span context
of its origin span for log ↔ trace joins. Gated content emits metadata-only events.

## Backend-specific capability extension points

A registration/callback mechanism so platform-specific behavior (today: the
Phoenix-compatible session annotations in `annotations.ts`) becomes pluggable instead
of core. The core implements semantics only (OTel GenAI semconv + OpenInference):

- Callback registration API, e.g. `onSessionCreated` / `onTurnEnded` / `onSpanEmitted`;
  the existing annotation becomes the first built-in extension (`tracing.annotations.*`
  config stays compatible); third parties can register their own backend adapters.
- User-defined entry points: extension module paths declared in the config, or
  programmatic registration; extensions receive the endpoint/headers/project config
  and the contentGates gate.
- Constraints: callbacks are always fire-and-forget with timeout protection (as the
  annotations are today), never block the span hot path; extension failures only warn.

## Trace head sampling (deferred, low priority)

A `tracing.sampleRatio` config (+ env override; semantics of opencode #44134's
`OPENCODE_TRACE_RATIO` / OTel `OTEL_TRACES_SAMPLER_ARG`). Deliberately deferred:
current deployments are audit-oriented and want full export; sampling only pays off
at org-wide volume.

Design sketch if picked up: decide at trace open from the deterministic traceId itself
(stateless, identical verdict across instances and reloads; all spans of an unselected
trace are dropped at emit time — head sampling keeps traces whole). Default stays
`1.0` (full export).

## Borrowed from Claude Code's monitoring-usage (medium/long-term)

Ideas lifted from <https://code.claude.com/docs/en/monitoring-usage>, ranked by
expected value vs implementation cost.

**Instrumentation gaps (span-level)**

- **TTFT / first-content timing on chat spans** — Claude exports `ttft_ms` and
  `first_content_ms` per llm_request. The plugin currently consumes completed text/reasoning only. The checked upstream
  schema already exposes `session.text.delta`, `session.reasoning.delta`, and
  `session.step.streamed`; evaluate their timing and correlation before calling this
  blocked on upstream support.
- **Per-retry span events** — Claude emits each retry attempt as a
  `gen_ai.request.attempt` span event (with `attempt` number +
  `client_request_id`). We currently stamp `opencode.retry.attempt` on the retrying
  span only; per-attempt timing/errors get flattened. Needs span-event support in
  `src/otlp.ts` (encoder + SpanRecord) plus a per-attempt timing source.
- **`request_id` / `client_request_id` on chat spans** — lets operators join our
  traces with provider-side logs. Depends on whether opencode's hook context /
  response headers expose the x-client-request-id and provider request id; needs
  recon.

- **`gen_ai.tool.call.{arguments,result}_original_length` + `*_truncated` boolean** — the wire
  JSONL records `frameBytes` and `truncated: true`; `input.value` / `output.value` already
  carry `_original_length` after the 60 KB cap, but the `gen_ai.tool.call.*` keys themselves
  lose all trace of the original size when capped. Adding the length + a boolean
  (`input.value_truncated`) lets backends query truncation cleanly
  (`WHERE input.value_truncated = true` instead of a LIKE on the marker text).

**Privacy / cardinality**

- **`*_safe` de-identified attribute family** — Claude emits `tool_name_safe`,
  `bash_command_class`, `bash_argv0`, `query_source_safe` alongside the gated
  originals: builtin names pass verbatim, user-defined names are bucketed
  (`mcp_other`, `custom`, …). Lets orgs run dashboards against tool/query mix
  without enabling `toolDetails`. Meaningful only at multi-user scale.
- **Managed-settings lock** — admin-forced OTLP endpoint/headers that override
  user config (Claude strips developer-set conflicts at startup). Only matters
  for org rollouts; today we document the env-override convention and rely on
  env > file > default precedence.

**Trace context propagation (bigger lifts)**

- Outbound primary-request header injection already ships through `model.request`; the
  remaining ideas below concern subprocess propagation, response links, and inbound context.

- **W3C `traceparent` propagation** — Claude (a) injects `TRACEPARENT` env into
  Bash/MCP subprocesses, (b) sends a `traceparent` header on the LLM request and
  records `traceresponse` as a span link, (c) accepts inbound `TRACEPARENT` when
  spawned by Agent SDK / `-p`. Would turn opencode into a first-class citizen of
  a wider distributed trace. Three separable workstreams, each an opt-in.

**Three-signal coverage**

- The OTLP metrics + logs/events export roadmap section above already covers
  this. Claude's event-stream vocabulary (`user_prompt` / `tool_decision` /
  `api_request` / `compaction` / `subagent_completed` …) is a useful reference
  when we scope the logs signal — most events map to events we already
  consume in `src/spans.ts`.
