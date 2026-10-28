# OpenCode events → GenAI semconv mapping

Authoritative one-page reference for what we capture from OpenCode and where each piece
lands in the emitted spans. Reflects `src/spans.ts` + `src/otlp.ts` (Real-time lane);
the on-disk wire JSONL is documented in `src/types.ts` and `README.md`. Traces lane
only — metrics-lane attributes and logs-lane event bodies are documented in the README's
Metrics and Log events tables.

Citations are `path:line` pointers.

## 1. Inbound sources

| Source | What it carries | Where it goes |
|---|---|---|
| `ctx.session.hook("prompt")` | `sessionID`, `messageID`, `prompt.text` | Stashed in `pendingPrompts`; the first `step.started` consumes it and opens the turn root (`spans.ts:363`) |
| `ctx.session.hook("experimental.ws.send")` | `sessionID`, `agent`, `model.{providerID,id}`, `kind`, `frame` | Written to per-session JSONL; also stashed per-session FIFO and consumed by the next `chat` span for `input.value` (`wire.ts:133`) |
| `ctx.session.hook("http.request")` | Same as `ws.send`, body is a cloned `ReadableStream` | Same path as above (`wire.ts:149`) |
| `ctx.event.subscribe()` → `session.*` SSE | All events listed in §2 | Drives the span state machine (`index.ts:155`) |
| `ctx.session.get({ sessionID })` | `parentID`, `agent`, `title`, `location.directory` | Lazily merged at turn/container close to fill `opencode.session.title/directory` (`index.ts:109`) |

`session.*` events handled (`spans.ts:328`):

| Event | Effect |
|---|---|
| `session.created` | Register session in map (parentID → sub-agent) |
| `session.deleted` | Flush any open turn root, drop all session state |
| `session.renamed` | Mutate cached `title` only |
| `session.step.started` | Open turn (if root + pending prompt); register step by `assistantMessageID` |
| `session.text.ended` | Append text to step; refresh turn's `lastAnswer` |
| `session.reasoning.ended` | Append reasoning chunk to step |
| `session.step.ended` / `.failed` | Emit `chat` span (consumes one wire frame); bump turn's `spanCount` |
| `session.tool.input.started` | Register tool by `callId`, remember `name` |
| `session.tool.called` | Register tool `input` (merges with prior `tool.input.started`) |
| `session.tool.success` / `.failed` | Emit `execute_tool` span; register sub-agent attachment if `name ∈ {subagent, task}` + `metadata.sessionID` |
| `session.compaction.started` / `.ended` / `.failed` | Open/close compaction run (one standalone trace per run; predecessor flushed bare on a second `started`) |
| `session.retry.scheduled` | Stamp `opencode.retry.*` onto the **next** `chat` span in the same session |
| `session.execution.succeeded` / `.failed` / `.interrupted` | Flush turn root (or sub-agent container) with terminal status |

## 2. Span inventory

| Span name | `kind` | Semconv `gen_ai.operation.name` | OpenInference `openinference.span.kind` | Trigger |
|---|---|---|---|---|
| `<40-char prompt preview>` (fall back to session title, then `"(empty)"`) | CLIENT (3) | `invoke_agent` | `AGENT` | `execution.succeeded/failed/interrupted` on a root session (`spans.ts:264`) |
| `chat <model.id>` | CLIENT | `chat` | `LLM` | `step.ended/failed` (`spans.ts:533`) |
| `execute_tool <name>` | INTERNAL (1) | `execute_tool` | `TOOL` | `tool.success/failed` (`spans.ts:624`) |
| `invoke_agent <agent>` (child session container) | CLIENT | `invoke_agent` | `AGENT` | `execution.finished` on a sub-agent session (`spans.ts:755`) |
| `compaction` | CLIENT | `compaction` | `LLM` | `compaction.ended/failed` (`spans.ts:701`) |

Span status: every span closes `code 1` (unset/ok) on success and `code 2` (error) on
failure, with `status.message = "<error.type>: <error.message>"` from the triggering
event (`step.failed` / `tool.failed` / `execution.failed` / `compaction.failed` /
`execution.interrupted` → `type: "interrupted"`).

## 3. Attribute inventory (by span kind)

Keys with a leading `→ gate` row are toggled off by the corresponding `tracing.contentGates.*` flag; see `src/config.ts:48`.
`tracing.contentMaxLength` is three-state (mirrors `wire.maxFrameBytes`): `-1` = no truncation,
`0` = metadata-only (the value attribute is omitted, `*_original_length` still emitted for spans that
provide one), `N > 0` = first N UTF-8 bytes (character-boundary safe) with a
`[TRUNCATED original_length=N]` marker plus `*_original_length`. Default is `61440` (60 KB) — sized
just under the 64 KB single-attribute limit enforced by common backends so one oversized tool result
cannot reject the whole span at intake; the budget is in bytes (not chars), so the cap holds for
CJK-heavy content too.
All attributes are skipped when their value is `null`/`undefined`/`""` (`spans.ts:78`).

### 3.1 Turn root (`invoke_agent` on a root session) — `spans.ts:264`

| Attribute | Source | Notes |
|---|---|---|
| `gen_ai.operation.name` | const `"invoke_agent"` | semconv |
| `gen_ai.provider.name` | const `"opencode"` | semconv |
| `gen_ai.agent.name` | turn's `agent` ∪ session registry | semconv |
| `gen_ai.conversation.id` | `sessionID` | semconv; also duplicated as `session.id` and `opencode.session.id` for Phoenix |
| `session.id` | `sessionID` | OpenInference native |
| `opencode.session.id` | `sessionID` | convenience alias |
| `opencode.session.title` | `session.renamed` ∪ `session.get.title` | refreshed at close |
| `opencode.session.directory` | `session.get.location.directory` | |
| `opencode.turn.index` | monotonically increasing counter per root session | 0-based |
| `opencode.turn.messages` | steps + tools emitted under this turn | diagnostic |
| `opencode.user_prompt.length` | `turn.inputText` size in UTF-8 bytes | ungated size signal; same unit as the truncation budget, useful when `userPrompts` gate is off |
| `openinference.span.kind` | `"AGENT"` | |
| `input.value` | turn's `prompt.text`, truncated | **Gate: `userPrompts`** |
| `input.value_original_length` | truncation marker | only when truncated |
| `output.value` | last `text.ended` aggregated across the turn, truncated | **Gate: `assistantResponses`** |
| `output.value_original_length` | truncation marker | |

### 3.2 Chat step (`chat ...`) — `spans.ts:533`

| Attribute | Source | Notes |
|---|---|---|
| `gen_ai.operation.name` | `"chat"` | |
| `gen_ai.provider.name` | `step.model.providerID` | |
| `gen_ai.request.model` / `gen_ai.response.model` | `step.model.id` | same value on both |
| `gen_ai.conversation.id` | `sessionID` | |
| `gen_ai.response.finish_reasons` | `data.finish` (string) | serialized as `["<finish>"]` |
| `gen_ai.usage.input_tokens` | `tokens.input + cache.read + cache.write` | semconv totals |
| `gen_ai.usage.output_tokens` | `tokens.output + tokens.reasoning` | |
| `gen_ai.usage.reasoning.output_tokens` | `tokens.reasoning` | |
| `gen_ai.usage.cache_read.input_tokens` | `tokens.cache.read` | |
| `gen_ai.usage.cache_write.input_tokens` | `tokens.cache.write` | |
| `gen_ai.output.messages` | `[{role:'assistant', parts:[{type:'text', content}]}]` JSON | **Gate: `assistantResponses`** |
| `opencode.cost.usd` | `data.cost` | USD per step |
| `opencode.reasoning` | concatenated reasoning chunks | **Gate: `assistantResponses`** |
| `openinference.span.kind` | `"LLM"` | |
| `llm.model_name` | `step.model.id` | mirror |
| `llm.token_count.prompt` | `input_tokens` above | mirror |
| `llm.token_count.completion` | `output_tokens` above | mirror |
| `llm.token_count.total` | `sum(input, output, reasoning, cache.read, cache.write)` | mirror |
| `llm.total_cost` | `data.cost` | mirror |
| `input.value` | one FIFO-consumed primary wire frame (full request JSON) | **Gate: `wireBody`**; requires `wire.enabled` |
| `input.mime_type` | `"application/json"` | only when the wire value survives truncation (omitted under metadata-only) |
| `input.value_original_length` | truncation marker | |
| `output.value` | concatenated text chunks, truncated | **Gate: `assistantResponses`** |
| `output.value_original_length` | truncation marker | |
| `opencode.message.id` | `assistantMessageID` | deterministic-id input |
| `opencode.agent` | `step.agent` | |
| `opencode.session.parent_id` | parent session's ID (from the subagent/task link or session registry) | sub-agent sessions only; same key as the invoke_agent container span |
| `opencode.retry.attempt` | stamped from prior `session.retry.scheduled` in the same session | consumed once |
| `opencode.retry.error` | stamped `"<type>: <message>"` from the same event | |
| `opencode.wire.seq` | `wire.seq` of the consumed frame | correlation back to the on-disk JSONL |

### 3.3 Tool call (`execute_tool <name>`) — `spans.ts:624`

| Attribute | Source | Notes |
|---|---|---|
| `gen_ai.operation.name` | `"execute_tool"` | |
| `gen_ai.tool.name` | `tool.name` (from `tool.input.started`) | falls back to `"unknown"` |
| `gen_ai.tool.call.id` | `toolCallId` | deterministic-id input |
| `gen_ai.tool.type` | `"function"` | |
| `gen_ai.conversation.id` | `sessionID` | |
| `gen_ai.agent.name` | `input.agent` — only when `name ∈ {subagent, task}` | identifies the child agent role |
| `gen_ai.tool.call.arguments` | `JSON.stringify(tool.input)` | **Gate: `toolDetails`** |
| `gen_ai.tool.call.result` | tool result content: text parts joined, other parts kept as objects | **Gate: `toolContent`** |
| `error.type` | `"tool_error"` | set only on failure |
| `openinference.span.kind` | `"TOOL"` | |
| `input.value` | same as `gen_ai.tool.call.arguments` | OpenInference mirror; **Gate: `toolDetails`** |
| `output.value` | same as `gen_ai.tool.call.result` | |
| `output.value_original_length` | truncation marker | |

### 3.4 Sub-agent container (`invoke_agent <agent>`) — `spans.ts:755`

| Attribute | Source | Notes |
|---|---|---|
| `gen_ai.operation.name` | `"invoke_agent"` | |
| `gen_ai.provider.name` | `"opencode"` | |
| `gen_ai.agent.name` | child session's `agent` field | |
| `gen_ai.conversation.id` | child `sessionID` | |
| `session.id` / `opencode.session.id` | child `sessionID` | |
| `opencode.session.parent_id` | registering parent's sessionID | |
| `opencode.session.title` / `opencode.session.directory` | from `session.get` on the child | |
| `openinference.span.kind` | `"AGENT"` | |

The container's parent is the `execute_tool {subagent,task}` span that registered the attachment
(`spans.ts:658`); the child session's own `chat` / `execute_tool` spans hang under this container.

### 3.5 Compaction — `spans.ts:701`

| Attribute | Source | Notes |
|---|---|---|
| `gen_ai.operation.name` | `"compaction"` | |
| `gen_ai.provider.name` / `gen_ai.request.model` / `gen_ai.response.model` | `session.compaction.ended`'s `data.model` | |
| `gen_ai.conversation.id` | `sessionID` | |
| `opencode.compaction.reason` | `compaction.started`'s `data.reason` (default `"unknown"`) | |
| `opencode.compaction.native` | `data.native` boolean | OpenCode's native vs plugin summarizer flag |
| `gen_ai.usage.input_tokens` / `output_tokens` / `reasoning.output_tokens` / `cache_read.input_tokens` / `cache_write.input_tokens` | `data.tokens` | same composition as chat spans |
| `opencode.cost.usd` | `data.cost` | |
| `openinference.span.kind` | `"LLM"` | |
| `llm.model_name` / `llm.token_count.prompt` / `.completion` / `.total` / `llm.total_cost` | mirrors | same shape as chat |
| `output.value` | the generated summary text | **Gate: `assistantResponses`** |
| `output.value_original_length` | truncation marker | |
| `session.id` / `opencode.session.id` | `sessionID` | |

## 4. Resource block (every batch) — `otlp.ts:109`

| Resource attribute | Source |
|---|---|
| `service.name` | `OTEL_SERVICE_NAME` env, else a `service.name` key in the merged resource attributes, else const `"opencode-genai-obs"` |
| `openinference.project.name` | `tracing.project` config (default `"opencode"`) |
| `<custom>` | `tracing.resourceAttributes` merged under `OTEL_RESOURCE_ATTRIBUTES` (env wins per key); builtin keys win on conflicts, except `service.name` |

Instrumentation scope: `{ name: "opencode-genai-obs", version: "<package version>" }`.

## 5. Deterministic IDs (frozen contract) — `src/ids.ts`, `tests/ids.test.ts`

| Target | Inputs (SHA-256 ingredients) |
|---|---|
| Turn root traceId / spanId | `sessionID × userMessageID` |
| Chat spanId | `assistantMessageID` |
| Tool spanId | `assistantMessageID × toolCallID` |
| Sub-agent container spanId | child `sessionID` |
| Compaction traceId / spanId | `sessionID × compaction.started timestamp` |
| Orphan trace (sub-agent with no parent link) | child `sessionID` |

Rationale: byte-identical ids let the offline replay lane dedup against the real-time lane
and make duplicate SSE deliveries harmless (Phoenix-style backends upsert on
`(traceId, spanId)`), so hot reloads and multi-realm dispatch cannot double-emit spans.

## 6. What we deliberately do NOT emit

- `gen_ai.request.temperature` / `top_p` / `max_tokens` / `stop_sequences` — these live
  only inside the wire body (`wire.frame`); surfacing them as attributes would duplicate
  the canonical OpenInference `input.value` payload.
- `gen_ai.system_instructions` — same reasoning; the system prompt is part of the wire
  frame (and gated by `contentGates.wireBody`).
- OTel span events (`gen_ai.client.inference.operation.details`, exception events) —
  statuses are encoded via OTLP `Status`, not events, to keep the encoder minimal.
- Logs (`log_body` on OpenInference) — the `log_body` convention is not used; message
  content ships via the opt-in OTLP logs lane (`src/logs.ts`). Plugin diagnostics go
  only to the local file sink (`~/.local/share/opencode/log/ocg-obs.*.log`), never to
  OTLP.

## 7. Cross-references

- State machine + per-span attribute construction: `src/spans.ts`
- Resource/Scope/Span protobuf encoding: `src/otlp.ts`
- Metrics lane (`gen_ai.client.*` histograms): `src/metrics.ts`
- Logs lane (`gen_ai.*` message events): `src/logs.ts`
- Config knobs feeding each gate: `src/config.ts` (`TracingConfig`)
- On-disk JSONL record schema: `src/types.ts` (`WireRecord`)
- Phoenix annotations (non-OTLP REST extension, orthogonal): `src/annotations.ts`
