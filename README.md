# opencode-genai-obs

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

<b>English</b> | <a href="README.zh-CN.md">简体中文</a>

**Audit-grade GenAI observability for OpenCode v2 — standard OTLP traces & metrics, plus transport-hook request capture.**

`opencode-genai-obs` hooks into the OpenCode v2 session event stream and transport layer, exporting structured agent traces over OTLP/HTTP (protobuf) to any compatible backend (Arize Phoenix, Jaeger, SigNoz, OTel Collector, …) while optionally recording provider request payloads observed at the hooks to local JSONL.

Where ops-monitoring plugins answer *"how many tokens did we burn today?"*, this plugin answers *"what exactly went over the wire, and why did this turn cost what it cost?"* — full request payloads on disk, deterministic trace/span IDs, and session-level audit annotations.

## Scope

Signals are **GenAI-semconv-scoped only**:

- **Traces** — spans under `gen_ai.*` (+ OpenInference mirrors), the main signal
- **Metrics** — `gen_ai.client.token.usage` and `gen_ai.client.operation.duration`; no infra/runtime or app-ops dashboard metrics (session counts, commit counters — that is the ops-monitoring plugin's job)
- **Events/logs** — opt-in: the legacy `gen_ai.*` message events (`system` / `user` / `tool` / `choice`; these names are deprecated in the checked OTel conventions). Content follows the content gates — a gated event still fires, metadata-only

Custom `opencode.*` span attributes are unaffected — the scope limits which signal *domains* we emit, not per-span attributes.

## What it instruments

### Traces

Each conversation turn is projected into a single trace in real time:

```text
<user prompt preview>                                    [AGENT · invoke_agent · 4.2s]
├── chat claude-sonnet-4-5           1,840 → 312 tok · $0.009  [LLM · chat]
│   ├── execute_tool grep            "timeout" in src/          [TOOL · execute_tool · 80ms]
│   └── execute_tool subagent (explorer)                       [TOOL · execute_tool]
│       └── invoke_agent explorer                              [AGENT · child session]
│           └── chat gemini-flash    920 → 180 tok             [LLM · chat]
│               └── execute_tool read src/auth/client.ts      [TOOL · execute_tool]
└── chat claude-sonnet-4-5           2,310 → 490 tok · $0.014  [LLM · chat]

compaction (auto)                    12,400 → 620 tok · $0.021 [LLM · standalone trace]
```

| Span | `gen_ai.operation.name` | Contents |
|---|---|---|
| Turn root | `invoke_agent` | User prompt preview (gated by `userPrompts`; `turn <messageID>` when off), final answer, session title/directory and emitted step/tool count; token usage and cost are on chat/compaction spans |
| `chat <model>` | `chat` | Provider/model, input/output/reasoning/cache token counts, cost, output messages (text + reasoning parts), wire-body `input.value` |
| `execute_tool <name>` | `execute_tool` | Tool name/call id, arguments, result, duration, sub-agent attachment |
| `invoke_agent <agent>` | `invoke_agent` | Child-session container span, linked under the parent tool span |
| `compaction` | `compaction` (plugin-defined; standalone trace) | Model, tokens, cost, summary, reason |

Retry events stamp `opencode.retry.attempt` / `opencode.retry.error` onto the following chat span.

Turn roots, sub-agent `execute_tool` spans, and `invoke_agent` containers set `gen_ai.agent.name` from the `tracing.agentName` template (default `"opencode/{agent}"`) — the GenAI semconv scopes the agent name to agent-operation spans, so chat spans do not carry it. Those three kinds plus chat spans all mirror the raw role name on the ungated `opencode.agent` attribute — query the bare name there regardless of the template. `tracing.agentName: ""` omits only `gen_ai.agent.name`; `opencode.agent` always stays.

### Metrics

| Metric | Type | Attributes |
|---|---|---|
| `gen_ai.client.token.usage` | Histogram (`{token}`) | `gen_ai.token.type` = `input` / `output` (input includes billable cache read/write), plus `gen_ai.provider.name` / `gen_ai.request.model` when that identity was observed (both omitted otherwise — never a placeholder) |
| `gen_ai.client.operation.duration` | Histogram (`s`) | `gen_ai.operation.name` (`chat` / `execute_tool`), provider & model for chat, `gen_ai.tool.name` for tools, `error.type` on failure |

### Log events (opt-in, legacy vocabulary)

| Event | When | Content gate |
|---|---|---|
| `gen_ai.user.message` | a root turn opens from a captured prompt (synthetic/unknown-origin turns emit no user event) | `userPrompts` |
| `gen_ai.system.message` | a chat span consumes a wire frame with a parseable system prompt (OpenAI `messages[0]` or Anthropic top-level `system`) | `wireBody` |
| `gen_ai.tool.message` | each tool call finishes | `toolContent` |
| `gen_ai.choice` | each LLM step ends (finish reason + completion) | `assistantResponses` |

`gen_ai.assistant.message` describes assistant messages in request history; `gen_ai.choice` describes responses. They are not aliases. This plugin emits response text as `choice`, does not emit historical assistant-input events, and uses deprecated event names; current conventions favor message attributes or `gen_ai.client.inference.operation.details`. Every event carries the deterministic trace/span context of its origin span, so backends can join log ↔ trace. A gated event still fires, metadata-only.

### Wire capture (local disk)

| Record | Contents |
|---|---|
| `<sessionID>.jsonl` (mode `0600`) | One JSON line per outbound LLM request: timestamp, sequence, hook (`ws.send` / `http.request`), session/agent/model, request kind (`primary` / `compaction` / `title` / `generate`), and the exact serialized request frame |

## Feature highlights

- **Deterministic trace & span IDs** — SHA-256 digests of stable session/message/call identifiers rather than random UUIDs: reproducible identity across plugin realms. The shared pipeline and terminal-event guards suppress duplicate processing; IDs alone do not prevent emission or guarantee backend upsert. The offline replay lane (crash repair, historical backfill) is planned future work and will reuse the same byte-identical IDs — see [TODO.md](TODO.md).
- **Raw wire-body capture** — request text observed at the transport hooks (full system prompt, message history, tool schemas, sampling parameters) lands on disk and/or in the chat span's `input.value`. See [Wire body capture](#wire-body-capture).
- **W3C trace-context propagation** — optionally injects `traceparent` into whitelisted providers' requests, so an OTel-instrumented gateway (LiteLLM, vLLM, …) parents its spans under ours: one end-to-end trace instead of two disconnected ones.
- **Session annotations** — project/title pushed to the Phoenix-compatible `/v1/session_annotations` REST API in real time (toggleable; off-standard but harmless elsewhere when disabled).
- **OTel GenAI semconv + OpenInference** — standard `gen_ai.*` attributes alongside OpenInference mirrors (`openinference.span.kind`, `llm.token_count.*`, `llm.total_cost`, `input.value`, `output.value`). Known departures from the checked conventions are listed in [source audit](docs/source-audit.md).
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
  },
  "metrics": { "enabled": false }
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

**OTel Collector** (4318 is the default; configure receivers and pipelines for the enabled signals):

```jsonc
{
  "tracing": { "endpoint": "http://localhost:4318", "annotations": { "enabled": false } }
}
```

**Jaeger**: use its OTLP trace receiver, disable Phoenix annotations, and disable or separately route metrics/logs. A trace receiver does not imply support for all signals.

**SigNoz Cloud** (one endpoint, ingestion key header; metrics included):

```jsonc
{
  "tracing": {
    "endpoint": "https://ingest.us.signoz.cloud:443",
    "headers": { "signoz-ingestion-key": "<SIGNOZ_INGESTION_KEY>" },
    "annotations": { "enabled": false }
  }
}
```

**Split routing** — traces to Phoenix, metrics to a metrics backend:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:6006"
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT="http://localhost:4318/v1/metrics"
```

## Configuration

Config lookup order: `OCG_OBS_CONFIG` > `OPENCODE_CONFIG_DIR/ocg-obs.json` > `$XDG_CONFIG_HOME/opencode/ocg-obs.json` > `~/.config/opencode/ocg-obs.json` (JSONC supported). All fields are optional and strictly type-checked (invalid types or unknown keys log a warning and fall back to defaults):

```jsonc
{
  "enabled": true,                        // master switch (false = no-op on setup)
  "tracing": {
    "enabled": true,                      // false + wire.enabled = wire-only mode (disk JSONL only, zero network egress)
    "endpoint": "http://localhost:4318",  // base OTLP/HTTP URL (4318 = standard OTLP; 6006 = Phoenix)
    "project": "opencode",                // sets the openinference.project.name resource attribute
    "headers": {},                        // shared header base for all signals and session annotations; per-signal headers override
    "content": true,                      // coarse gate: false defaults toolDetails & toolContent to false
    "contentGates": {                     // fine-grained gates (each overrides `content`)
      "userPrompts": true,                //   turn root input.value + the prompt preview in its span name
      "assistantResponses": true,         //   root/chat output.value, gen_ai.output.messages, opencode.reasoning, compaction text
      "toolDetails": true,                //   gen_ai.tool.call.arguments & tool input.value
      "toolContent": true,                //   gen_ai.tool.call.result & tool output.value
      "wireBody": true                    //   chat span input.value from the captured wire frame (requires wire.enabled)
    },
    "contentMaxLength": 61440,            // retained UTF-8 content budget (default 60 KiB; truncation suffix is extra).
                                          //   No universal OTel 64 KB cap; backend limits vary.
                                          //   -1 = unlimited, 0 = metadata-only
                                          //   (value omitted, *_original_length kept), N > 0 = first N bytes + [TRUNCATED]
    "resourceAttributes": {},             // merged into the OTLP Resource block (builtin keys take precedence)
    "annotations": { "enabled": true },   // POST session project/title to /v1/session_annotations (Phoenix REST extension;
                                          // set false on non-Phoenix backends to avoid 404 retries)
    "propagation": { "providers": [] },   // W3C traceparent injection into outbound model requests: provider IDs (or "*")
                                           // whose primary requests carry the in-flight chat span's context, so an
                                           // OTel-instrumented gateway (LiteLLM, vLLM, …) can parent its spans under
                                           // ours. Title/compaction/generate requests are never injected.
    "fastShutdown": true,                  // CLI fast-fail shortcuts at shutdown (150 ms TCP pre-probe + skip the final
                                           // flush after a failed export). Set false for strict remote/proxied collectors:
                                           // shutdown then always attempts the final flush within the same bounded budgets
    "agentName": "opencode/{agent}"        // gen_ai.agent.name template; "{agent}" → the agent role name (build/plan/
                                           // reasoner/actor/general/explore or custom). Default "opencode/{agent}" keeps
                                           // the framework identity visible when multiple AI CLIs share one backend;
                                           // "{agent}" = bare role name; "" = omit the attribute entirely. The raw role
                                           // name always lands on the ungated opencode.agent attribute, so queries on
                                           // the bare name are template-independent. Keep cardinality low: never
                                           // template in message or session ids.
  },
  "metrics": {
    "enabled": true,                      // gen_ai.client.token.usage + gen_ai.client.operation.duration via OTLP/HTTP
                                          // protobuf. Phoenix does not ingest metrics — point
                                          // OTEL_EXPORTER_OTLP_METRICS_ENDPOINT at a metrics backend (or disable).
    "intervalMs": 60000                  // export interval
  },
  "wire": {
    "enabled": false,                     // append raw provider request payloads to per-session JSONL
    "directory": "~/.local/share/opencode/raw-requests",  // per-session JSONL output directory
    "maxFrameBytes": -1                   // retained frame-string budget; suffix, metadata, and JSON escaping are extra
  },
  "logs": {
    "enabled": false,                     // opt-in gen_ai.* message events (system/user/tool/choice), OTLP/HTTP protobuf.
                                          // Content overlaps span attributes — enable when the backend indexes
                                          // log events better than spans. Gated content still emits, metadata-only.
    "intervalMs": 2000                   // batch export delay (BatchLogRecordProcessor scheduledDelayMillis)
  }
}
```

### Disabling signals

| Signal | How |
|---|---|
| Everything | `"enabled": false` (plugin becomes a no-op) |
| All network egress | `"tracing.enabled": false` + `"wire.enabled": true` → wire-only mode (disk JSONL only) |
| Metrics only | `"metrics.enabled": false` |
| Log events only | default off; `"logs.enabled": true` to enable |
| Session annotations only | `"tracing.annotations.enabled": false` |
| Trace-context propagation | default off; configure `tracing.propagation.providers` to enable |
| Shutdown fast-fail shortcuts | `"tracing.fastShutdown": false` — shutdown always attempts the final flush within the bounded budgets (strict remote/proxied collectors) |
| `gen_ai.agent.name` templating | default `"opencode/{agent}"`; `"{agent}"` = bare role name, `""` = omit the attribute (the raw name stays on `opencode.agent`) |

### Environment variables

The plugin gives the following environment variables precedence over its config file (**env > config file > defaults**). Its endpoint normalization is plugin-specific: it strips a final `/v1/<signal>` and exporters append their own signal path. The SDK normally uses signal-specific URLs verbatim and only appends paths to the generic endpoint; arbitrary custom signal paths are not preserved by this plugin.

| Variable | Target |
|---|---|
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (fallback: `OTEL_EXPORTER_OTLP_ENDPOINT`) | `tracing.endpoint` (trailing `/v1/traces` is stripped automatically) |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` (fallback: `OTEL_EXPORTER_OTLP_ENDPOINT`) | `metrics.endpoint` (trailing `/v1/metrics` is stripped automatically) |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` (fallback: `OTEL_EXPORTER_OTLP_ENDPOINT`) | `logs.endpoint` (trailing `/v1/logs` is stripped automatically) |
| `OTEL_EXPORTER_OTLP_HEADERS` + per-signal `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_HEADERS` | per-signal headers (`k1=v1,k2=v2`, percent-decoded; each signal merges generic < signal-specific, no cross-signal leakage) |
| `OTEL_RESOURCE_ATTRIBUTES` | `tracing.resourceAttributes` (`k1=v1,k2=v2`, percent-decoded) |
| `OTEL_SERVICE_NAME` | resource `service.name` on all signals (wins over `OTEL_RESOURCE_ATTRIBUTES`; default `opencode-genai-obs`) |
| `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`, `OTEL_EXPORTER_OTLP_COMPRESSION` | handled by the official OTel SDK exporters |
| `OTEL_EXPORTER_OTLP_TIMEOUT` (and per-signal timeout variables) | SDK handling for metrics/logs; traces explicitly set `timeoutMillis` to 30000 ms by default, overriding environment timeouts |

## Wire body capture

Capture records the WebSocket frame string or cloned HTTP request decoded with `Request.text()` at this plugin's hook. Later hooks can still modify the request, and hook observation does not prove successful transmission. HTTP capture is text, not arbitrary byte-preserving capture. Failed reads, read timeouts, disposal, or disk errors can leave gaps.

When `wire.enabled: true`, observed requests are recorded to `~/.local/share/opencode/raw-requests/<sessionID>.jsonl` (mode `0600`):

```json
{
  "v": 1,
  "ts": "2026-10-27T03:25:06.123Z",
  "captureID": "61b9be54-60c5-4d98-806d-1202a7827471",
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
- `(captureID, seq)` identifies a record across recorder restarts: `captureID` is a UUID per recorder instance, and `seq` increases across all its sessions. Chat spans retain this pair as `opencode.wire.capture_id` / `opencode.wire.seq` even when body capture on spans is gated off or has a zero content budget. Legacy records without `captureID` cannot be uniquely joined across restarts using `seq` alone.
- `wire.maxFrameBytes` limits the retained **on-disk frame string**, not the complete serialized JSONL record (spans still receive the full frame, governed by `contentGates.wireBody` + `contentMaxLength`):
  - `-1` (default): full payload
  - `0`: metadata-only (`frame: ""`, `truncated: true`, `frameBytes: <original_bytes>`)
  - `N > 0`: first `N` bytes cut at a UTF-8 character boundary, suffixed with `[TRUNCATED]`, plus `truncated: true` and `frameBytes`

## Diagnostics & development

- **Logs**: `~/.local/share/opencode/log/ocg-obs.<timestamp>-<pid>.log` (7-day retention, automatic secret redaction).
- **Startup probe**: when tracing is enabled, one TCP connect per distinct configured OTLP endpoint (traces/metrics/logs, deduplicated) at boot logs `otlp endpoint reachable` or `otlp endpoint UNREACHABLE — spans will queue/retry until the backend comes up` — log-only diagnostics; the sender's retry/backoff owns the behavioral response. Wire-only mode never probes (zero network egress).
- **Shutdown**: unloading the plugin always respects spec-mandated bounds — at most about 1.5 s in total. The traces lane gets a 1 s drain budget + 0.5 s close budget; the metrics and logs lanes run concurrently with it under their own 500 ms bound each (a shutdown that exceeds it is abandoned with a warning, never awaited), so the total stays ~1.5 s rather than summing the three signals. Spans/samples/log batches still queued when a bound is hit are dropped, never retried at shutdown. On top of those bounds, `tracing.fastShutdown` (default `true`) adds CLI fast-fail shortcuts: a 150 ms TCP probe that drops the queue at once when nothing listens on the endpoint (`otlp drain: endpoint not reachable`), and skipping the final flush after a failed export. Set `tracing.fastShutdown: false` to disable both shortcuts — the drain/close budgets stay enforced, but shutdown always attempts the final flush within them (strict remote/proxied collectors).
- **Attribute mapping**: [docs/semconv-mapping.md](docs/semconv-mapping.md) — what we capture from OpenCode → where it lands in GenAI semconv / OpenInference.
- **Source verification**: [docs/source-audit.md](docs/source-audit.md) — local relative paths, checked versions, and implementation limitations.
- **Roadmap**: [TODO.md](TODO.md)

```bash
npm run build      # compile src/ → dist/
npm run typecheck  # tsc --noEmit
npm test           # compile and run the node:test suite
```
