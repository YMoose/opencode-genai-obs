# TODO / Roadmap

Future directions, not commitments. Traces are the current focus — nothing here affects
the tracing path.

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
