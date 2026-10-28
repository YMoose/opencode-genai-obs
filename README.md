# opencode-genai-obs

<b>English</b> | <a href="README.zh-CN.md">简体中文</a>

OpenCode v2 plugin: GenAI-semconv OTLP tracing + LLM wire body capture, exporting to any OTLP/HTTP-compatible backend (OTel Collector / Phoenix / SigNoz / Jaeger …). It aligns with semantic conventions only (OTel GenAI semconv + OpenInference) and is not tied to any specific observability platform.

> **Status: running in production.** Wire body capture (Phase 1) and real-time OTLP tracing (Phase 2) are live and battle-tested. **The plugin handles real-time only**; historical/crash backfill goes through the offline lane in `obsystem/otel-span-exportor` (export → adapter → send, sharing the plugin's idempotent id scheme).

## Installation

Add this repository's absolute path to the `plugin` array in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["/home/cambricon/yzh/ocg-obs"]
}
```

Restart opencode.

## Feature: Real-time OTLP tracing (Phase 2)

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
- The default endpoint is the standard OTLP port `http://localhost:4318`; it previously defaulted to the Phoenix port `6006` — Phoenix deployments relying on the default must now set the endpoint explicitly (**migration note**)
- No backend-specific request headers are sent; the project semantic goes exclusively through the `openinference.project.name` resource attribute
- `tracing.annotations.enabled: false` turns off the Phoenix-compatible session annotations (recommended for non-Phoenix backends to avoid 404-retry noise)
- OTLP POSTs and annotation requests carry a 30s timeout; a hung backend can no longer stall the send queue or plugin unload
- `session.deleted` events clean up all in-memory state for that session (leak protection for long-lived processes)
- If a hot reload unloads the old pipeline owner first, surviving instances' hook callbacks re-elect a new owner automatically — capture keeps running

## Feature: Wire body capture

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
  "sessionID": "ses_e84ae6de0ffeS1LUNCUejdumYi",
  "agent": "sisyphus",
  "model": { "providerID": "volces", "id": "volces/kimi-k3" },
  "kind": "primary",
  "frame": "{\"model\":\"volces/kimi-k3\",\"messages\":[...],\"tools\":[...],\"temperature\":0.6,...}"
}
```

- `hook`: which hook captured it (`ws.send` is the main path, `http.request` is the fallback)
- `kind`: `primary` | `compaction` | `title` | `generate` (opencode's own request classification)
- `frame`: the full wire body (frame string for ws, request-body text for http)
- `seq`: process-wide monotonically increasing sequence number

**Privacy**: bodies contain the full system prompt + history + tools. Files are mode 0600, never committed to git, never sent anywhere. Delete the files when you no longer need them.

## Roadmap / TODO

- [x] **Phase 1**: wire body capture (v2 `experimental.ws.send` + `http.request` hooks → JSONL)
      ✅ Verified in production 2026-10-27: frames are provider-native JSON
      (system/messages/tools/max_tokens/thinking); volces/kimi-k3 goes through the
      `http.request` path (registering both hooks is required); compaction requests are
      captured as well; no duplicate writes observed with multi-instance loading.
      Size note: a single primary frame is ~1.4MB (336 messages + 21 tools) — disk grows fast.
- [x] **Phase 2**: event-driven span builder (`session.step.*` / `session.tool.*` events →
      OTel GenAI spans, exported in real time)
      ✅ Verified in production 2026-10-27: chat/tool spans land within seconds; wire frames
      flow precisely into `input.value` (OpenInference); the turn root span is held back until
      execution ends; sub-agent attachment points register via metadata.sessionID.
      Key obstacle on record: opencode loads an isolated module realm per location (observed
      3 per process); hooks dispatch per location and each instance gets its own event
      subscription → resolved via a globalThis pipeline singleton.
- [ ] ~~**Phase 3**: startup replay (full projection from storage, as a crash/missed-event
      backstop)~~ **Dropped** (decided 2026-10-27): the plugin handles real-time only.
      Crash repair / historical backfill / re-ingestion belongs to the official offline lane
      in `obsystem/otel-span-exportor` (its id algorithm is byte-identical to `src/ids.ts`
      → idempotent dedup via Phoenix-style `DO_NOTHING` upserts).
      Rationale: none of the four scenarios is a real-time need, and automatic replay is a
      dangerous default side effect. See the design doc §3.
- [x] **Phase 2.5**: real-time session annotations (`session.created`/`session.renamed` →
      POST `/v1/session_annotations`; project/title columns update within seconds on
      Phoenix-compatible backends; sub-agent sessions are skipped; 3 retries with the
      offline sync.py as backstop; now controlled by `tracing.annotations.enabled` and can
      be turned off for non-Phoenix backends) ✅ Verified 2026-10-27
- [x] **Phase 2.6**: compaction & retry coverage (opencode [#35935](https://github.com/anomalyco/opencode/pull/35935) parity)
      ✅ `session.compaction.started/ended/failed` → one standalone trace per run
      (`gen_ai.operation.name=compaction`, model, `gen_ai.usage.*`, `opencode.cost.usd`,
      summary text behind the `assistantResponses` gate; failed → error status;
      unterminated runs are flushed bare on unload). `session.retry.scheduled` →
      `opencode.retry.attempt`/`opencode.retry.error` stamped onto the session's *next*
      chat span (the failed step's span is already emitted by the time the retry is
      scheduled); the stamp is consumed once. Deterministic ids:
      `opencode-compaction:{sid}:{startedMs}` (2026-10-27)
- [ ] ~~**Phase 5**: replace the full `obsystem/otel-span-exportor` script chain~~ **Dropped**:
      that chain has been promoted to the official offline repair/backfill lane and coexists
      with the plugin (see the Phase 3 note)
- [ ] **TODO (future direction, not a commitment)**: OTLP **metrics + logs/events** (following
      the metrics/logs sections of the same Claude Code monitoring-usage doc; **traces remain
      the current focus — this does not affect the tracing path**)
      - Metric candidates (data source = the existing session event stream, zero new capture):
        `opencode.session.count` (created), `opencode.llm.tokens{model,direction}` (step.ended),
        `opencode.cost.usd` (step.ended cost), `opencode.tool.calls{tool,status}`
        (tool.success/failed), turn/tool duration histograms; export via OTLP/HTTP JSON
        (Phoenix does not ingest metrics; target backends are SigNoz / OTel collector → Prometheus)
      - Logs/events candidates: `user_prompt` / `tool_result` / `step_failed` events, reusing
        contentGates as the content gate; via the OTLP logs protocol
      - Configuration follows the existing OTEL env conventions (separate
        `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` / `_LOGS_ENDPOINT` routes); tracing stays on HTTP, no gRPC
- [ ] **TODO (future direction, not a commitment)**: **Backend-specific capability extension
      points (registration/callback mechanism)** — abstract the acquisition and writing of
      backend-exclusive fields (currently `annotations.ts`'s session project/title) out of the
      core path into registrable extension points. The core implements semantics only
      (OTel GenAI semconv + OpenInference); all platform-specific behavior moves to extensions:
      - Callback registration API: e.g. `onSessionCreated` / `onTurnEnded` / `onSpanEmitted`;
        the existing Phoenix annotation becomes the first built-in extension (the
        `tracing.annotations.*` config stays compatible), and third parties can register
        their own backend adapters
      - User-defined entry points: declare extension module paths in the config file (aligned
        with opencode's plugin directory-loading convention) or register programmatically;
        extensions receive the endpoint/headers/project config and the contentGates content gate
      - Constraints: extension callbacks are always fire-and-forget with timeout protection
        (as annotations are today), must never block the span hot path; extension failures
        only warn and never affect tracing
- [ ] **TODO (deferred, low priority)**: trace **head sampling** — a `tracing.sampleRatio`
      config (+ env override, semantics of opencode #44134's `OPENCODE_TRACE_RATIO` /
      OTel `OTEL_TRACES_SAMPLER_ARG`). Deliberately not implemented: current deployments are
      audit-oriented and want full export; sampling only pays off at org-wide volume.
      Design sketch if ever picked up: decide at trace open from the deterministic traceId
      itself (stateless, identical verdict across instances/reloads and the offline replay
      lane; all spans of an unselected trace are dropped at emit time — head sampling keeps
      traces whole). Default stays `1.0` (full export)

Design doc: `../obsystem/otel-span-exportor/MERGED-PLUGIN.md`  
Research: `../obsystem/otel-span-exportor/RESEARCH.md`

## Development

```bash
npm run build      # compile src/ → dist/
npm run typecheck  # type check
npm test           # compile and run the node:test suite (tests/ → dist-test/)
```

Test coverage: the span state machine (deterministic ids, content gates, malformed-event guards, session cleanup), OTLP encoding/POST (timeout, non-200), the send queue (retry, dropping), annotation retries, wire capture/flush, config validation, redaction and logging (patterns adopted from oh-my-opencode-slim), plugin contracts (disabled setup never touches ctx, idempotent unload, reload re-establishment, symmetric hook deregistration), and a dependency contract (minimal runtime dependency closure + src import-graph boundary).
