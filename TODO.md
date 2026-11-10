# TODO / Roadmap

Future directions, not commitments. Traces are the current focus — nothing here affects
the tracing path.

## Semconv gaps confirmed by source audit

See `docs/source-audit.md` for checked versions and relative source paths. These are runtime
follow-ups; the documentation correction does not change emitted data or frozen ID formulas.

- Cache-write tokens are dual-emitted since Bug 41 (2026-11-10): standard
  `gen_ai.usage.cache_creation.input_tokens` plus the legacy self-invented
  `gen_ai.usage.cache_write.input_tokens` (kept temporarily for existing dashboards;
  its removal is a future release decision).
- `gen_ai.response.finish_reasons` is a true `string[]` since Bug 42 (2026-11-10):
  `AttrValue` was widened to flat scalar arrays and the OTLP `arrayValue` encoding is
  pinned by a byte-signature regression test. Breaking type change from the previous
  JSON-string form (user decision option A — no mirror, one-field-one-source).
- `gen_ai.response.model` duplicates the requested model; use independently observed response
  identity when available rather than implying that the duplicate is a provider observation.
- Chat duration includes step settlement. Evaluate `session.step.streamed` and request-start
  timing before presenting this as model-request latency.
- Truncating JSON-valued attributes can break their JSON/schema validity. Define an explicit
  representation for oversized structured content before changing the truncation path.
- Legacy message-event names are deprecated; plan any migration separately from retaining
  current backend compatibility.


## Bug 33 (resolved 2026-11-10)

Fixed by the `endedTools` guard at the tool-start re-creation entry — commit "fix:
guard tool-start re-creation against endedTools to prevent phantom spans at unload
(Bug 33)"; adjudication in [docs/decisions.md](docs/decisions.md) (2026-11-10 entry);
the replay-only stamping variant stays recorded-only.

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
  (the split is carried by `gen_ai.usage.cache_read.input_tokens` and the
  dual-emitted cache-write pair `gen_ai.usage.cache_creation.input_tokens` /
  legacy `gen_ai.usage.cache_write.input_tokens` — same value, Bug 41).
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

## Watch items

- GenAI semconv (now at <https://github.com/open-telemetry/semantic-conventions-genai>)
  suggests INTERNAL span kind for in-process `gen_ai.invoke_agent.internal` spans; our
  turn root uses CLIENT — watch only, no action.
- Upstream PR [anomalyco/opencode#61414](https://github.com/anomalyco/opencode/pull/61414)
  (fork branch `subagent-interrupt-reason`, "preserve parent interruption reason in
  subagents"): open since 2026-11-03, CI green, bot review positive, no maintainer
  activity. Upstream has since refactored run-coordinator (internal
  `execution.interruptionReason` + new `settled` callback) without the PR's interface
  method → rebase + adaptation required if pushed. Repo moved sst/opencode →
  anomalyco/opencode (old URLs redirect). When merged and shipped, the host emits real
  subagent interrupt reasons, completing `opencode.interrupt.reason` data (Bug 30).
  User decision 2026-11-10: wait. Sibling open PRs #58556 / #58433 are equally idle.
