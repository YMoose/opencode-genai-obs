# opencode-genai-obs

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

<b>English</b> | <a href="README.zh-CN.md">简体中文</a>

**Audit-grade GenAI observability for OpenCode v2 — standard OTLP traces & metrics, plus full-fidelity raw wire capture.**

`opencode-genai-obs` hooks into the OpenCode v2 session event stream and transport layer, exporting structured agent traces over OTLP/HTTP (protobuf) to any compatible backend (Arize Phoenix, Jaeger, SigNoz, OTel Collector, …) while optionally recording the exact provider request payloads to local JSONL.

Where ops-monitoring plugins answer *"how many tokens did we burn today?"*, this plugin answers *"what exactly went over the wire, and why did this turn cost what it cost?"* — full request payloads on disk, deterministic trace/span IDs, and session-level audit annotations.

## Scope

Signals are **GenAI-semconv-scoped only**:

- **Traces** — spans under `gen_ai.*` (+ OpenInference mirrors), the main signal
- **Metrics** — `gen_ai.client.token.usage` and `gen_ai.client.operation.duration`; no infra/runtime or app-ops dashboard metrics (session counts, commit counters — that is the ops-monitoring plugin's job)
- **Events/logs** — the five `gen_ai.*` message events (`system` / `user` / `assistant` / `tool` / `choice`), if a logs lane is added

Custom `opencode.*` span attributes are unaffected — the scope limits which signal *domains* we emit, not per-span attributes.

## What it instruments

### Traces

Each conversation turn is projected into a single trace in real time:

```text
<user prompt preview>                                    [AGENT · invoke_agent · 4.2s]
├── chat claude-sonnet-4-5           1,840 → 312 tok · $0.009  [LLM · chat]
├── execute_tool grep                "timeout" in src/         [TOOL · execute_tool · 80ms]
├── execute_tool subagent (explorer)                           [TOOL · execute_tool]
│   └── invoke_agent explorer                                  [AGENT · child session]
│       ├── chat gemini-flash        920 → 180 tok             [LLM · chat]
│       └── execute_tool read        src/auth/client.ts        [TOOL · execute_tool]
└── chat claude-sonnet-4-5           2,310 → 490 tok · $0.014  [LLM · chat]

compaction (auto)                    12,400 → 620 tok · $0.021 [LLM · standalone trace]
```

| Span | `gen_ai.operation.name` | Contents |
|---|---|---|
| Turn root | `invoke_agent` | User prompt preview, final answer, session title/directory, token & message totals, cost |
| `chat <model>` | `chat` | Provider/model, input/output/reasoning/cache token counts, cost, output messages, wire-body `input.value` |
| `execute_tool <name>` | `execute_tool` | Tool name/call id, arguments, result, duration, sub-agent attachment |
| `invoke_agent <agent>` | `invoke_agent` | Child-session container span, linked under the parent tool span |
| `compaction` | — (standalone trace) | Model, tokens, cost, summary, reason |

Retry events stamp `opencode.retry.attempt` / `opencode.retry.error` onto the following chat span.

### Metrics

| Metric | Type | Attributes |
|---|---|---|
| `gen_ai.client.token.usage` | Histogram (`{token}`) | `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.token.type` = `input` / `output` (input includes billable cache read/write) |
| `gen_ai.client.operation.duration` | Histogram (`s`) | `gen_ai.operation.name` (`chat` / `execute_tool`), provider & model for chat, `gen_ai.tool.name` for tools, `error.type` on failure |

### Wire capture (local disk)

| Record | Contents |
|---|---|
| `<sessionID>.jsonl` (mode `0600`) | One JSON line per outbound LLM request: timestamp, sequence, hook (`ws.send` / `http.request`), session/agent/model, request kind (`primary` / `compaction` / `title` / `generate`), and the exact serialized request frame |

## Feature highlights

- **Deterministic trace & span IDs** — SHA-256 digests of stable session/message/call identifiers rather than random UUIDs: idempotent deduplication across plugin realms, and byte-identical IDs in the offline replay lane (crash repair, historical backfill).
- **Raw wire-body capture** — the exact JSON sent to the provider (full system prompt, message history, tool schemas, sampling parameters) lands on disk and/or in the chat span's `input.value`. See [Wire body capture](#wire-body-capture).
- **W3C trace-context propagation** — optionally injects `traceparent` into whitelisted providers' requests, so an OTel-instrumented gateway (LiteLLM, vLLM, …) parents its spans under ours: one end-to-end trace instead of two disconnected ones.
- **Session annotations** — project/title pushed to the Phoenix-compatible `/v1/session_annotations` REST API in real time (toggleable; off-standard but harmless elsewhere when disabled).
- **OTel GenAI semconv + OpenInference** — standard `gen_ai.*` attributes alongside OpenInference mirrors (`openinference.span.kind`, `llm.token_count.*`, `llm.total_cost`, `input.value`, `output.value`). Zero platform lock-in.
- **Privacy gates & secret redaction** — independent content gates mirroring Claude Code's `OTEL_LOG_*` semantics, byte-accurate truncation with a three-state budget, and automatic credential redaction in plugin logs.
- **Official OTel SDK at the wire boundary** — OTLP protobuf encoding is delegated to `@opentelemetry/exporter-trace-otlp-proto` / `-metrics-`; the pipeline above it (span state machine, deterministic IDs, retry/drain queue) is ours.

## Quick start

**1. Build and register**

```bash
git clone https://github.com/YMoose/opencode-genai-obs.git
cd opencode-genai-obs && npm install && npm run build
```

Add the plugin path to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["/absolute/path/to/opencode-genai-obs"]
}
```

**2. Configure the OTLP endpoint** (optional — defaults to `http://localhost:4318`)

For example, with a local [Arize Phoenix](https://github.com/Arize-ai/phoenix) instance (`docker run -p 6006:6006 arizephoenix/phoenix`), create `~/.config/opencode/ocg-obs.json`:

```jsonc
{
  "tracing": {
    "endpoint": "http://localhost:6006"
  }
}
```

**3. Restart OpenCode.** Traces stream to `/v1/traces` as steps and tools complete.

## Backend recipes

**Arize Phoenix** (traces + annotations; Phoenix does not ingest metrics — disable them or route them elsewhere):

```jsonc
{
  "tracing": { "endpoint": "http://localhost:6006", "project": "ocg-obs" },
  "metrics": { "enabled": false }
}
```

**OTel Collector / Jaeger** (4318 is the default; nothing to configure unless customized):

```jsonc
{
  "tracing": { "endpoint": "http://localhost:4318" }
}
```

**SigNoz Cloud** (one endpoint, ingestion key header; metrics included):

```jsonc
{
  "tracing": {
    "endpoint": "https://ingest.us.signoz.cloud:443",
    "headers": { "signoz-ingestion-key": "<SIGNOZ_INGESTION_KEY>" }
  }
}
```

**Split routing** — traces to Phoenix, metrics to a metrics backend:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:6006"
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT="http://localhost:4318"
```

## Configuration

Config lookup order: `OCG_OBS_CONFIG` > `OPENCODE_CONFIG_DIR/ocg-obs.json` > `~/.config/opencode/ocg-obs.json` (JSONC supported). All fields are optional and strictly type-checked (invalid types or unknown keys log a warning and fall back to defaults):

```jsonc
{
  "enabled": true,                        // master switch (false = no-op on setup)
  "tracing": {
    "enabled": true,                      // false + wire.enabled = wire-only mode (disk JSONL only, zero network egress)
    "endpoint": "http://localhost:4318",  // base OTLP/HTTP URL (4318 = standard OTLP; 6006 = Phoenix)
    "project": "opencode",                // sets the openinference.project.name resource attribute
    "headers": {},                        // extra headers for /v1/traces and /v1/session_annotations
    "content": true,                      // coarse gate: false defaults toolDetails & toolContent to false
    "contentGates": {                     // fine-grained gates (each overrides `content`)
      "userPrompts": true,                //   turn root input.value
      "assistantResponses": true,         //   root/chat output.value, gen_ai.output.messages, opencode.reasoning, compaction text
      "toolDetails": true,                //   gen_ai.tool.call.arguments & tool input.value
      "toolContent": true,                //   gen_ai.tool.call.result & tool output.value
      "wireBody": true                    //   chat span input.value from the captured wire frame (requires wire.enabled)
    },
    "contentMaxLength": 61440,            // max UTF-8 bytes per content attribute (default 60 KB, sized under the 64 KB
                                          //   single-attribute backend limit): -1 = unlimited, 0 = metadata-only
                                          //   (value omitted, *_original_length kept), N > 0 = first N bytes + [TRUNCATED]
    "resourceAttributes": {},             // merged into the OTLP Resource block (builtin keys take precedence)
    "annotations": { "enabled": true },   // POST session project/title to /v1/session_annotations (Phoenix REST extension;
                                          // set false on non-Phoenix backends to avoid 404 retries)
    "propagation": { "providers": [] }    // W3C traceparent injection into outbound model requests: provider IDs (or "*")
                                          // whose primary requests carry the in-flight chat span's context, so an
                                          // OTel-instrumented gateway (LiteLLM, vLLM, …) can parent its spans under
                                          // ours. Title/compaction/generate requests are never injected.
  },
  "metrics": {
    "enabled": true,                      // gen_ai.client.token.usage + gen_ai.client.operation.duration via OTLP/HTTP
                                          // protobuf. Phoenix does not ingest metrics — point
                                          // OTEL_EXPORTER_OTLP_METRICS_ENDPOINT at a metrics backend (or disable).
    "intervalMs": 60_000,                 // export interval
    "endpoint": null                      // metrics endpoint override (default: OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
                                          // > OTEL_EXPORTER_OTLP_ENDPOINT > tracing.endpoint)
  },
  "wire": {
    "enabled": false,                     // append raw provider request payloads to per-session JSONL
    "maxFrameBytes": -1                   // on-disk frame cap: -1 = full, 0 = metadata only, N > 0 = first N bytes
  }
}
```

### Disabling signals

| Signal | How |
|---|---|
| Everything | `"enabled": false` (plugin becomes a no-op) |
| All network egress | `"tracing.enabled": false` + `"wire.enabled": true` → wire-only mode (disk JSONL only) |
| Metrics only | `"metrics.enabled": false` |
| Session annotations only | `"tracing.annotations.enabled": false` |
| Trace-context propagation | default off; configure `tracing.propagation.providers` to enable |

### Environment variables

Standard OpenTelemetry environment variables override the config file (**env > config file > defaults**), enabling zero-touch organization rollouts:

| Variable | Target |
|---|---|
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (fallback: `OTEL_EXPORTER_OTLP_ENDPOINT`) | `tracing.endpoint` (trailing `/v1/traces` is stripped automatically) |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` (fallback: `OTEL_EXPORTER_OTLP_ENDPOINT`) | `metrics.endpoint` (trailing `/v1/metrics` is stripped automatically) |
| `OTEL_EXPORTER_OTLP_HEADERS` + `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | `tracing.headers` (`k1=v1,k2=v2`, W3C Baggage percent-decoded; traces-specific wins) |
| `OTEL_RESOURCE_ATTRIBUTES` | `tracing.resourceAttributes` (`k1=v1,k2=v2`, percent-decoded) |

## Wire body capture

When `wire.enabled: true`, each outbound LLM request is recorded to `~/.local/share/opencode/raw-requests/<sessionID>.jsonl` (mode `0600`):

```json
{
  "v": 1,
  "ts": "2026-10-27T03:25:06.123Z",
  "seq": 42,
  "hook": "ws.send",
  "sessionID": "ses_example0123456789",
  "agent": "build",
  "model": { "providerID": "example", "id": "example/model-x" },
  "kind": "primary",
  "frame": "{\"model\":\"example/model-x\",\"messages\":[...],\"tools\":[...],\"temperature\":0.6}"
}
```

- `kind`: OpenCode's request classification (`primary` | `compaction` | `title` | `generate`). Only `primary` frames are consumed into chat-span `input.value` (FIFO).
- `wire.maxFrameBytes` caps **on-disk** JSONL frames only (spans still receive the full frame, governed by `contentGates.wireBody` + `contentMaxLength`):
  - `-1` (default): full payload
  - `0`: metadata-only (`frame: ""`, `truncated: true`, `frameBytes: <original_bytes>`)
  - `N > 0`: first `N` bytes cut at a UTF-8 character boundary, suffixed with `[TRUNCATED]`, plus `truncated: true` and `frameBytes`

## Diagnostics & development

- **Logs**: `~/.local/share/opencode/log/ocg-obs.<timestamp>-<pid>.log` (7-day retention, automatic secret redaction).
- **Attribute mapping**: [docs/semconv-mapping.md](docs/semconv-mapping.md) — what we capture from OpenCode → where it lands in GenAI semconv / OpenInference.
- **Roadmap**: [TODO.md](TODO.md)

```bash
npm run build      # compile src/ → dist/
npm run typecheck  # tsc --noEmit
npm test           # compile and run the node:test suite
```
