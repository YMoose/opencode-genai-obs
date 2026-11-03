# Source verification

Checked on 2026-11-03. Plugin baseline: `b2e58439bb6d3a146fd71d7fb5ffa44493466830`.
OpenCode baseline: `c5fea455b5af7765c021b808afd294937a99f9b8`.
Paths beginning with `src/` refer to this plugin; paths beginning with `packages/` refer
to the OpenCode repository root. This audit changes documentation, not runtime behavior.

## Plugin behavior and upstream evidence

- `src/otlp.ts` — normal spans export `SpanStatusCode.OK` (1), failures export ERROR (2).
  UNSET is 0. The adapter converts its OTLP-numbered kinds to JS API kinds before export;
  its comment claiming the kind enums match numerically is inaccurate, but the conversion
  itself handles the two kinds used here. The adapter emits no span events or links.

- `src/spans.ts`, `emitToolSpan` and `flushTurn` — tools are children of their issuing chat
  spans. A linked subagent container is a child of the delegating tool; its chat spans
  contain its own tool spans. Root turns expose emitted step/tool count, not aggregate
  token counts or cost. Tool results are JSON array strings, not joined plain text.

- `src/spans.ts`, `openTurn`, and `src/logs.ts` — only prompt-origin root turns emit
  `gen_ai.user.message`; synthetic and unknown-origin turns do not. Responses emit text
  as `gen_ai.choice`; historical assistant-input events are not emitted. The legacy
  assistant-input event and response event are distinct concepts, not aliases.

- `packages/core/src/session/usage.ts` — OpenCode normalizes `output` from
  `visibleOutputTokens` and stores `reasoningTokens` separately. The plugin correctly
  adds `tokens.output + tokens.reasoning`; this differs from the Harness accounting
  where reasoning is already included in output. Input is uncached input plus cache read/write.

- `packages/schema/src/session-event.ts`, `packages/core/src/session/runner/step.ts`,
  and `packages/core/src/session/runner/publish-llm-event.ts` — step settlement includes
  tool settlement and snapshot work. `session.step.streamed` separately marks the provider
  response-body boundary. The plugin does not consume that event, so its chat duration is
  a step interval. Text and reasoning delta events also exist upstream; missing TTFT capture
  is not evidence that upstream has no streaming signals.

- `src/spans.ts` — `step.model.id` is copied into both request and response model attributes;
  the response model is not independently observed. The emitted cache-write attribute is
  `gen_ai.usage.cache_write.input_tokens`. Finish reasons are JSON strings, not array-valued
  attributes. These implementation choices must not be described as full semconv compliance.

- `src/config.ts` — JSONC is parsed with `jsonc-parser`; numeric separators such as
  `60_000` are not valid JSONC. File `tracing.headers` is the shared base for all three
  signals, overridden by signal-specific file headers and then generic/signal-specific env
  headers. Signal-specific env headers do not leak across signals.

- `src/config.ts`, `src/otlp.ts`, `src/metrics.ts`, and `src/logs.ts` — the plugin strips a
  trailing `/v1/<signal>` and appends its own path. This differs from the SDK's verbatim
  signal-specific endpoint behavior. Trace export explicitly defaults `timeoutMillis`
  to 30000, taking precedence over timeout environment variables. `tracing.project` is
  automatically added only to the trace resource.

- `src/wire.ts` and `packages/core/src/session/model-request.ts` — the plugin sees a
  WebSocket frame string or a web Request and reads a clone as text. Later hooks can
  modify it before transport dispatch. Capture does not prove successful transmission;
  read failures/timeouts, disposal, and disk errors can leave gaps. The per-session pending
  queue retains at most eight primary frames, consumed FIFO; frame sequence is recorder-wide,
  not a per-file line number or a durable identifier across recorder restarts.

- `src/spans.ts` and `src/wire.ts` — content budgets limit retained UTF-8 prefixes; suffixes,
  metadata, and JSON escaping add bytes. Truncated JSON content may no longer parse as JSON.
  These limits do not guarantee backend acceptance or total record size.

- `src/index.ts` and `packages/core/src/session/model-request.ts` — outbound `traceparent`
  propagation is implemented through `model.request`, subject to provider, request kind,
  active step, agent, and model checks. It is not an unimplemented upstream capability.

- `src/ids.ts`, `src/spans.ts`, and `src/index.ts` — deterministic IDs, terminal guards,
  and a shared pipeline have different roles. IDs alone do not suppress duplicate export
  or guarantee backend upsert. Offline replay remains future work, and the existing ID
  formulas are unchanged by this documentation audit.

## OpenTelemetry reference baseline

- Locally installed `@opentelemetry/api` 1.9.1 and `@opentelemetry/otlp-transformer`
  0.219.0 confirm status values and the JS-to-OTLP kind offset.

- `@opentelemetry/semantic-conventions` 1.43.0 identifies the cache-write key as
  `gen_ai.usage.cache_creation.input_tokens`, marks the legacy message events deprecated,
  and does not enumerate `compaction` as a predefined operation. Its separate relocation
  notices for GenAI exports are not the same as replacing legacy message events.

- The local Go OTel 1.44.0 semantic-convention definitions for v1.40.0 explicitly type
  `gen_ai.response.finish_reasons` as `string[]`. JSON-string encoding changes that type.

- `@opentelemetry/sdk-trace-base` 2.12.0 and `@opentelemetry/otlp-exporter-base` 0.219.0
  provide the SDK reference for configurable attribute limits and endpoint/timeout precedence.
  OTel defines no universal 64 KB attribute ceiling.

## Follow-up

- Runtime semconv changes need their own regression tests and compatibility review:
  cache-write naming, finish-reason array typing, model identity, structured-content truncation,
  and model-request timing. They are recorded in `TODO.md`; this audit does not change them.
