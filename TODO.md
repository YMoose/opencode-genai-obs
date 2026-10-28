# TODO / Roadmap

Future directions, not commitments. Traces are the current focus — nothing here affects
the tracing path.

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

## OTLP metrics + logs/events export

Data source is the existing session event stream (zero new capture):

- Metric candidates: `opencode.session.count` (created),
  `opencode.llm.tokens{model,direction}` (step.ended), `opencode.cost.usd`
  (step.ended cost), `opencode.tool.calls{tool,status}` (tool.success/failed),
  turn/tool duration histograms.
- Export via OTLP/HTTP JSON (Phoenix does not ingest metrics; target backends are
  SigNoz / OTel Collector → Prometheus).
- Logs/events candidates: `user_prompt` / `tool_result` / `step_failed` events,
  reusing contentGates as the content gate, via the OTLP logs protocol.
- Configuration follows the existing OTEL env conventions (separate
  `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` / `_LOGS_ENDPOINT` routes); stays on HTTP, no gRPC.

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
