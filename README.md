# opencode-genai-obs

<b>English</b> | <a href="README.zh-CN.md">简体中文</a>

OpenCode v2 plugin: GenAI-semconv OTLP tracing + LLM wire body capture, exporting to any OTLP/HTTP-compatible backend (OTel Collector / Phoenix / SigNoz / Jaeger …). It aligns with semantic conventions only (OTel GenAI semconv + OpenInference) and is not tied to any specific observability platform.

> **Status: stable, running in production.** Real-time only — crash repair and historical backfill are handled by a separate offline lane outside this repository.

## Installation

Add this repository's absolute path to the `plugin` array in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["/absolute/path/to/opencode-genai-obs"]
}
```

Restart opencode.

## Real-time OTLP tracing

On by default: session event stream → OTel GenAI semconv spans → OTLP/HTTP backend (protobuf). One conversation turn = one trace (the root span carries the user-message summary); chat spans (LLM calls, with the full wire body) and `execute_tool` spans show up within seconds. Sub-agent sessions attach as a subtree under the tool span that spawned them. Each compaction run lands as its own trace (model, usage, cost, summary behind the `assistantResponses` gate), and retry attempts are stamped onto the retried chat span (`opencode.retry.attempt` / `opencode.retry.error`).

```jsonc
{
  "tracing": {
    "enabled": true,                    // default true
    "endpoint": "http://localhost:4318",// any OTLP/HTTP backend; 4318 = standard OTLP port
                                        // (Phoenix users: http://localhost:6006)
    "project": "opencode",              // openinference.project.name resource attribute
    "headers": {},                      // extra request headers (auth), shared by /v1/traces and /v1/session_annotations
    "content": true,                    // coarse switch: false → toolDetails / toolContent default off
    "contentGates": {                   // fine-grained gates (each overridable, mirrors Claude Code OTEL_LOG_* semantics)
      "userPrompts": true,              //   root-span input.value (user message)
      "assistantResponses": true,       //   root output.value, chat output.value, gen_ai.output.messages, reasoning
      "toolDetails": true,              //   tool call arguments (defaults to follow content)
      "toolContent": true,              //   tool call result (defaults to follow content)
      "wireBody": true                  //   wire body into chat-span input.value (false = JSONL only)
    },
    "contentMaxLength": 0,              // max chars for content attributes, 0 = no truncation;
                                        // truncation appends an [TRUNCATED] marker plus *_original_length attributes
    "resourceAttributes": {},           // merged into the OTLP resource block (host.name / team.*; builtin keys win)
    "annotations": { "enabled": true }  // real-time session project/title columns (Phoenix-compatible
                                        // /v1/session_annotations, not an OTLP standard; disable for other backends)
  },
  "wire": { "enabled": true }           // wire body to disk + into chat-span input.value
}
```

### Environment variables (override the config file, standard OTEL conventions)

For organization-wide rollout, drive everything via shell env — no per-user config edits:

| Variable | Effect |
|---|---|
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (falls back to `OTEL_EXPORTER_OTLP_ENDPOINT`) | `tracing.endpoint`; a trailing `/v1/traces` path is stripped automatically |
| `OTEL_EXPORTER_OTLP_HEADERS` + `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | `tracing.headers` (`k1=v1,k2=v2`; traces-specific wins; values percent-decoded per W3C Baggage) |
| `OTEL_RESOURCE_ATTRIBUTES` | `tracing.resourceAttributes` (same format) |

Precedence: **env > config file > defaults** (same convention as the Claude Code monitoring-usage docs).
Config file lookup: `OCG_OBS_CONFIG` > `OPENCODE_CONFIG_DIR/ocg-obs.json` > `~/.config/opencode/ocg-obs.json`.

Config validation: every field is type-checked; a mismatch (e.g. the string `"false"`) **warns and falls back to the default** instead of silently passing through JS truthiness. Unknown keys (typos) are reported at the root, `wire`, `tracing`, and `contentGates` levels. Warnings go to the log.

Behavior notes:

- `tracing.enabled: false` + `wire.enabled: true` = **wire-only mode**: JSONL capture only, no event-stream subscription, nothing leaves the process
- The default endpoint is the standard OTLP port `http://localhost:4318`; Phoenix users should set `http://localhost:6006` explicitly
- No backend-specific request headers are sent; the project semantic goes exclusively through the `openinference.project.name` resource attribute
- `tracing.annotations.enabled: false` turns off the Phoenix-compatible session annotations (recommended for non-Phoenix backends to avoid 404-retry noise)
- OTLP POSTs and annotation requests carry a 30s timeout; a hung backend can no longer stall the send queue or plugin unload
- `session.deleted` events clean up all in-memory state for that session (leak protection for long-lived processes)
- Capture keeps running across plugin hot reloads

## Wire body capture

Every raw request body sent to the LLM (full system prompt + trimmed messages + tools schema + sampling params + provider-specific options) is appended to a JSONL file.

**Off by default.** To enable, create `~/.config/opencode/ocg-obs.json`:

```json
{
  "wire": {
    "enabled": true
  }
}
```

Location: `~/.local/share/opencode/raw-requests/<sessionID>.jsonl`, one record per line:

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
  "frame": "{\"model\":\"example/model-x\",\"messages\":[...],\"tools\":[...],\"temperature\":0.6,...}"
}
```

- `hook`: which hook captured it (`ws.send` is the main path, `http.request` is the fallback)
- `kind`: `primary` | `compaction` | `title` | `generate` (opencode's own request classification)
- `frame`: the full wire body (frame string for ws, request-body text for http)
- `seq`: process-wide monotonically increasing sequence number

**Privacy**: bodies contain the full system prompt + history + tools. Files are mode 0600, never committed to git, never sent anywhere. Delete the files when you no longer need them.

## Roadmap / TODO

- [ ] OTLP metrics + logs/events export (session/tool/token/cost metrics and log events
      from the existing event stream, via the OTLP HTTP protocols)
- [ ] Backend-specific capability extension points — a registration/callback mechanism so
      platform-specific behavior (today: the Phoenix-compatible session annotations)
      becomes pluggable instead of core
- [ ] Trace head sampling (`tracing.sampleRatio`; deferred — full export stays the default)

## Development

```bash
npm run build      # compile src/ → dist/
npm run typecheck  # type check
npm test           # compile and run the node:test suite (tests/ → dist-test/)
```

Test coverage: the span state machine (deterministic ids, content gates, malformed-event guards, session cleanup), OTLP encoding/POST (timeout, non-200), the send queue (retry, dropping), annotation retries, wire capture/flush, config validation, redaction and logging (patterns adopted from oh-my-opencode-slim), plugin contracts (disabled setup never touches ctx, idempotent unload, reload re-establishment, symmetric hook deregistration), and a dependency contract (minimal runtime dependency closure + src import-graph boundary).
