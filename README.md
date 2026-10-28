# opencode-genai-obs

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

<b>English</b> | <a href="README.zh-CN.md">简体中文</a>

**OpenTelemetry GenAI tracing and raw LLM wire capture for OpenCode v2.**

`opencode-genai-obs` hooks into the OpenCode v2 session event stream and transport layer, exporting structured agent traces over OTLP/HTTP (protobuf) to any compatible backend (Arize Phoenix, Jaeger, SigNoz, OTel Collector, …) while optionally recording the exact provider request payloads to local JSONL.

## Trace model & capabilities

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

- **Turn-scoped trace hierarchy** — One user turn = one trace (`invoke_agent` root span → `chat` model steps → `execute_tool` calls). Child sessions spawned via `subagent` / `task` link their `invoke_agent` container span directly under the parent tool span.
- **OTel GenAI semconv + OpenInference** — Populates standard `gen_ai.*` attributes (`gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens` / `output_tokens` / `cache_read.input_tokens` / `cache_write.input_tokens` / `reasoning.output_tokens`, `gen_ai.tool.call.*`) alongside OpenInference mirrors (`openinference.span.kind`, `llm.token_count.*`, `llm.total_cost`, `input.value`, `output.value`). Zero platform lock-in.
- **Compaction & retry instrumentation** — Context compaction runs (`session.compaction.*`) emit standalone traces with model, token, cost, and summary attributes. Retried steps (`session.retry.scheduled`) stamp `opencode.retry.attempt` and `opencode.retry.error` onto the subsequent `chat` span.
- **Raw wire-body capture** — Intercepts the exact serialized JSON sent to the LLM provider (full system prompt, message history, tool schemas, sampling parameters) for on-disk JSONL inspection and/or attachment to the chat span's `input.value`.
- **Deterministic trace & span IDs** — IDs are SHA-256 digests of stable session/message/call identifiers rather than random UUIDs, guaranteeing idempotent deduplication across realms and offline replay pipelines.
- **Privacy gates & secret redaction** — Independent content gates mirroring Claude Code's `OTEL_LOG_*` semantics (`userPrompts`, `assistantResponses`, `toolDetails`, `toolContent`, `wireBody`), configurable character/byte truncation, and automatic credential redaction in plugin logs.

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
    "contentMaxLength": 0,                // max chars per content attribute (0 = unlimited; appends [TRUNCATED] + *_original_length)
    "resourceAttributes": {},             // merged into the OTLP Resource block (builtin keys take precedence)
    "annotations": { "enabled": true }    // POST session project/title to /v1/session_annotations (Phoenix REST extension;
                                          // set false on non-Phoenix backends to avoid 404 retries)
  },
  "wire": {
    "enabled": false,                     // append raw provider request payloads to per-session JSONL
    "maxFrameBytes": -1                   // on-disk frame cap: -1 = full, 0 = metadata only, N > 0 = first N bytes
  }
}
```

### Environment variables

Standard OpenTelemetry environment variables override the config file (**env > config file > defaults**), enabling zero-touch organization rollouts:

| Variable | Target |
|---|---|
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (fallback: `OTEL_EXPORTER_OTLP_ENDPOINT`) | `tracing.endpoint` (trailing `/v1/traces` is stripped automatically) |
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
