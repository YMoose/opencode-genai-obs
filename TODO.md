# TODO / Roadmap

Future directions, not commitments. Traces are the current focus — nothing here affects
the tracing path.

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
- **Billable-input token math**: `gen_ai.usage.input_tokens` and the
  `gen_ai.client.token.usage` input type both include cache read + cache write
  (separate `gen_ai.usage.cache_read/write.input_tokens` attributes carry the split).
- **Truncation semantics**: `contentMaxLength` sentinel chain (-1 = full, 0 = metadata
  only, N>0 = N-byte cap with `[TRUNCATED original_length=N]` marker) applies equally
  to replayed content.
- **Signal surface**: traces are the point; metrics/logs lanes stay optional (the
  replay host may have no metrics backend). Wire frames are absent in replay — the
  `gen_ai.system.message` event simply doesn't fire.
- The id formulas themselves (`opencode-turn/chat/tool` prefixes, byte lengths) are
  frozen by `tests/ids.test.ts`; the replay lane reads them from `src/ids.ts` verbatim.

## Event coverage: skills / permissions / usage / non-session namespaces

The SSE pump currently filters to `session.*` events only, but `ctx.event.subscribe()`
exposes the full event namespace. Known gaps, all actionable today (verified against the
v2 schema in `packages/schema/src/session-event.ts`):

- `session.skill.activated` (skill id/name/text) — exists in the stream, not handled
- `session.permissions` (ruleset changes) — exists, not handled
- `session.usage.updated` (rolling cost totals) — exists, not handled
- Non-session namespaces: `permission.*` (request/decision pairing — wait-duration
  metric if the decision event is actually pushed), `mcp.*` (connection lifecycle)
- Out of reach without core support (for reference): outbound traceparent injection,
  raw provider response bodies, transport-level detail (status codes, SDK retries),
  model-request terminal-state distinctions (refused / cancelled / retries-exhausted),
  structured MCP server attribution on tool events, plugin/skill load lifecycle,
  session-level end events

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
assistant.message folds into choice). Every event carries the deterministic span context
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
  `first_content_ms` per llm_request. Requires a first-chunk timestamp source from
  opencode (SSE wire signal or streaming hook); we only see start/end today.
  Highest observability value per unit effort; blocked on an upstream signal.
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
