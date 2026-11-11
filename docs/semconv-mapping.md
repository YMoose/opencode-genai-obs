# OpenCode events → GenAI semconv mapping

Reference for what we capture from OpenCode and where each piece
lands in the emitted spans. Reflects `src/spans.ts` + `src/otlp.ts` (Real-time lane);
the on-disk wire JSONL is documented in `src/types.ts` and `README.md`. Traces lane
only — metrics-lane attributes and logs-lane event bodies are documented in the README's
Metrics and Log events tables.

Source paths refer to this plugin repository; upstream paths and checked revisions are listed in
[source audit](source-audit.md). The GenAI semconv source of truth is
<https://github.com/open-telemetry/semantic-conventions-genai> (prose under `docs/gen-ai/`,
YAML model under `model/`) — the former opentelemetry.io gen-ai pages are tombstoned.

## 1. Inbound sources

| Source | What it carries | Where it goes |
|---|---|---|
| `ctx.session.hook("prompt")` | `sessionID`, `messageID`, `prompt.text` | Stashed in `pendingPrompts`; the first `step.started` consumes it and opens the turn root (`src/spans.ts`) |
| `ctx.session.hook("experimental.ws.send")` | `sessionID`, `agent`, `model.{providerID,id}`, `kind`, `frame` | Written to per-session JSONL; also stashed per-session FIFO and consumed by the next `chat` span for `input.value` (`src/wire.ts`) |
| `ctx.session.hook("http.request")` | Same as `ws.send`, payload contains a web `Request`, which the recorder clones and reads with `.text()` | Same path as above (`src/wire.ts`) |
| `ctx.event.subscribe()` → `session.*` SSE | Events listed below | Drives the span state machine (`src/index.ts`) |
| `ctx.session.get({ sessionID })` | `parentID`, `agent`, `title`, `location.directory` | Lazily merged at turn/container close to fill `opencode.session.title/directory` (`src/index.ts`) |

`session.*` events handled (`src/spans.ts`):

| Event | Effect |
|---|---|
| `session.created` | Register session in map (parentID → sub-agent) |
| `session.deleted` | Flush any open turn root, drop all session state |
| `session.renamed` | Mutate cached `title` only |
| `session.synthetic` | Stash wakeup text in `pendingWakes` (Bug 25) |
| `session.inbox.enqueued` | Stash wakeup text when `data.item.type === "synthetic"` (subagent-completion wakeup; real user input is captured by the prompt hook, not here) |
| `session.step.started` | Open turn (root session: from pending prompt or wakeup, else unknown-origin `auto:` identity); register step by `assistantMessageID` |
| `session.text.ended` | Append text to step; refresh turn's `lastAnswer` |
| `session.reasoning.ended` | Append reasoning chunk to step |
| `session.step.ended` / `.failed` | Emit `chat` span (consumes one wire frame); bump turn's `spanCount` |
| `session.tool.input.started` | Register tool by `callId`, remember `name` |
| `session.tool.called` | Register tool `input` (merges with prior `tool.input.started`) |
| `session.tool.success` / `.failed` | Emit `execute_tool` span; register sub-agent attachment if `name ∈ {subagent, task}` + `metadata.sessionID` |
| `session.compaction.started` / `.ended` / `.failed` | Open/close compaction run (one standalone trace per run; predecessor flushed bare on a second `started`) |
| `session.retry.scheduled` | Stamp `opencode.retry.*` onto the **next** `chat` span in the same session, within the round that scheduled it (expired at round close, Bug 50) |
| `session.execution.succeeded` / `.failed` / `.interrupted` | Flush turn root (or sub-agent container) with terminal status |

## 2. Span inventory

Kinds below use OTLP numbers (`CLIENT = 3`, `INTERNAL = 1`). The JS API uses `CLIENT = 2`,
`INTERNAL = 0`; `src/otlp.ts` converts to JS values before the SDK serializes them.
`compaction` is a plugin-defined operation value, not a predefined checked semconv value.

| Span name | `kind` | Semconv `gen_ai.operation.name` | OpenInference `openinference.span.kind` | Trigger |
|---|---|---|---|---|
| `<40-char prompt/wakeup preview>` (fall back to session title, then `turn <userMessageID>`) | CLIENT (3) | `invoke_agent` | `AGENT` | `execution.succeeded/failed/interrupted` on a root session (`src/spans.ts`) |
| `chat <model.id>`, or bare `chat` when no model was observed (Bug 48) | CLIENT | `chat` | `LLM` | `step.ended/failed` (`src/spans.ts`) |
| `execute_tool <name>`, or bare `execute_tool` when no name was observed (Bug 48) | INTERNAL (1) | `execute_tool` | `TOOL` | `tool.success/failed` (`src/spans.ts`) |
| `invoke_agent <agent>` (child session container) | CLIENT | `invoke_agent` | `AGENT` | `execution.succeeded/failed/interrupted` on a sub-agent session (`src/spans.ts`) |
| `compaction` | CLIENT | `compaction` | `LLM` | `compaction.ended/failed` (`src/spans.ts`) |

The turn-root name's prompt preview is **content** and answers to the same gate as
`input.value`: with `contentGates.userPrompts` off — or `contentMaxLength: 0`
(metadata-only) — the name collapses to the opaque turn identity `turn <userMessageID>`,
and a positive `contentMaxLength` budget bounds the preview to the same byte count
(Bug 47). The session title is deliberately NOT used as the gated fallback: hosts
auto-generate it from the prompt, so it would leak the same text. With capture on, the
title remains the fallback for rounds with no prompt text at all (Bug 3).

Span status: every span closes `code 1` (`OK`, not `UNSET`; `UNSET = 0`) on success and `code 2` (error) on
failure, with `status.message = "<error.type>: <error.message>"` from the triggering
event (`step.failed` / `tool.failed` / `execution.failed` / `compaction.failed` /
`execution.interrupted` → `type: "interrupted"`). Unload teardown is a further status
source (`flushAll`, `src/spans.ts`): open turns, sub-agent containers, and
in-flight tools emit ERROR `interrupted` / `interrupted: plugin_unload`; in-flight
compactions keep their bare span as OK by decision (user decision 2026-11-03) — a bare
flush is a tombstone with an UNKNOWN outcome, not a claimed success; changing it was
considered and declined.

## 3. Attribute inventory (by span kind)

Keys marked **Gate** are toggled off by the corresponding `tracing.contentGates.*` flag; see `src/config.ts`.
`tracing.agentName` templates the `gen_ai.agent.name` value on turn roots, sub-agent tool spans, and
sub-agent containers: `{agent}` occurrences are replaced with the agent role name at emission
(default `"opencode/{agent}"`, `""` = omit the attribute, malformed brace usage → warning + default).
The raw role name is always mirrored on the ungated `opencode.agent` attribute (chat spans already
carried it; the other three kinds were extended), so queries on the bare name are template-independent.
`tracing.contentMaxLength` is three-state (mirrors `wire.maxFrameBytes`): `-1` = no truncation,
`0` = metadata-only (the value attribute is omitted, `*_original_length` still emitted for spans that
provide one), `N > 0` = first N UTF-8 bytes (character-boundary safe) with a
`[TRUNCATED original_length=<original UTF-8 bytes>]` marker plus `*_original_length`.
The default is `61440` (60 KiB) of retained content; the suffix is extra. OTel defines no universal
64 KB attribute ceiling, and this budget does not guarantee backend acceptance. Truncating
JSON-valued strings can also make them invalid JSON — truncated JSON-valued attributes may
be unparseable prefix excerpts while still declaring `application/json` (record-only
decision 2026-11-10).
All attributes are skipped when their value is `null`/`undefined`/`""` (`src/spans.ts`).

Every span kind also carries these ungated observation attributes:

| Attribute | Values | Meaning |
|---|---|---|
| `opencode.observation.end_source` | `host_event` / `plugin_flush` | Whether a host event or plugin-side flush caused emission |
| `opencode.observation.end_trigger` | Exact host event name or local flush reason | Host events include `session.step.ended/failed`, `session.tool.success/failed`, `session.execution.succeeded/failed/interrupted`, `session.compaction.ended/failed`, and `session.deleted`; local reasons are `plugin_unload`, `new_prompt`, and `compaction_replaced` (or an explicit `flushAll` reason) |
| `opencode.observation.terminal_observed` | boolean | The plugin received the corresponding step/tool/execution/compaction terminal; false for local flushes and `session.deleted` |

These fields describe the observation boundary, not capture completeness or task success.
A failed host terminal still sets `terminal_observed=true`; an unloaded compaction still
has the legacy OK status but sets `terminal_observed=false`. Session deletion flushes only
an open root turn; other session state is dropped without emitting additional spans.
`opencode.interrupt.reason` remains exclusively the host's execution-interruption enum.
Older spans without these attributes have unknown observation provenance.

### 3.1 Turn root (`invoke_agent` on a root session) — `src/spans.ts`

| Attribute | Source | Notes |
|---|---|---|
| `gen_ai.operation.name` | const `"invoke_agent"` | semconv |
| `gen_ai.provider.name` | — not emitted | this slot is the **inference** provider (`openai` / `anthropic` / …), which is not known at turn-root scope; framework identity lives in `service.name` + `gen_ai.agent.name` (Bug 48) |
| `gen_ai.agent.name` | rendered from the `tracing.agentName` template (`{agent}` → turn's `agent` ∪ session registry), default `"opencode/{agent}"` | semconv; omitted when the raw role name is missing or the template is `""` |
| `opencode.agent` | turn's `agent` ∪ session registry | raw role name, ungated; the template-independent query key |
| `gen_ai.conversation.id` | `sessionID` | semconv; also duplicated as `session.id` and `opencode.session.id` for Phoenix |
| `session.id` | `sessionID` | OpenInference native |
| `opencode.session.id` | `sessionID` | convenience alias |
| `opencode.session.title` | `session.renamed` ∪ `session.get.title` | refreshed at close |
| `opencode.session.directory` | `session.get.location.directory` | |
| `opencode.turn.index` | monotonically increasing counter per root session | 0-based |
| `opencode.turn.messages` | steps + tools emitted under this turn | diagnostic |
| `opencode.turn.wakeup` | `"synthetic"` \| `"unknown"` | non-user round origin marker (Bug 25): `synthetic` = round opened by a wakeup event, `unknown` = no prompt hook and no wakeup observed; absent on user rounds |
| `opencode.user_prompt.length` | `turn.inputText` size in UTF-8 bytes | user rounds only (Bug 25); ungated size signal; same unit as the truncation budget, useful when `userPrompts` gate is off |
| `opencode.interrupt.reason` | `execution.interrupted` `reason` | host enum only: `"user" \| "shutdown" \| "superseded" \| "inactivity"` (Bug 30); on interrupted turn roots; one field, one source of meaning (user decision, option B, 2026-11-03) — NEVER set by plugin-side synthetic interrupts: ABSENT at plugin-unload teardown, where the status message carries `interrupted: plugin_unload` instead (Bug 34) |
| `openinference.span.kind` | `"AGENT"` | |
| `input.value` | user round: the prompt; synthetic round: the wakeup text (`session.synthetic` / synthetic `session.inbox.enqueued`); unknown round: omitted | **Gate: `userPrompts`** |
| `input.value_original_length` | truncation marker | when shortened or withheld by a zero budget |
| `output.value` | last `text.ended` aggregated across the turn, truncated | **Gate: `assistantResponses`** |
| `output.value_original_length` | truncation marker | |

The root span records step/tool count, input/output text, and session metadata; it does not
aggregate token counts or cost.

### 3.2 Chat step (`chat ...`) — `src/spans.ts`

| Attribute | Source | Notes |
|---|---|---|
| `gen_ai.operation.name` | `"chat"` | |
| `gen_ai.provider.name` | `step.model.providerID` | omitted when the step event carried no provider (Bug 48) |
| `gen_ai.request.model` | `step.model.id` | omitted when the step event carried no model id — `gen_ai.request.model` is `Conditionally Required` "*If available*" in the GenAI semconv, and a fabricated `"unknown"` claimed a model nobody requested (Bug 48) |
| `gen_ai.response.model` | — not emitted | not independently observed in the response; clean absence until wire-derived observation lands (Bug 43, user decision 2026-11-10) |
| `gen_ai.conversation.id` | `sessionID` | |
| `gen_ai.response.finish_reasons` | `data.finish` (string) | true `string[]` attribute (`[finish]`); breaking type change — was a JSON string `["<finish>"]` (user decision option A, no mirror; Bug 42, 2026-11-10) |
| `gen_ai.usage.input_tokens` | `tokens.input + cache.read + cache.write` | semconv totals |
| `gen_ai.usage.output_tokens` | `tokens.output + tokens.reasoning` | Correct for OpenCode: `output` is visible output only, separate from reasoning |
| `gen_ai.usage.reasoning.output_tokens` | `tokens.reasoning` | |
| `gen_ai.usage.cache_read.input_tokens` | `tokens.cache.read` | |
| `gen_ai.usage.cache_creation.input_tokens` | `tokens.cache.write` | standard key (semantic-conventions 1.43.0, `ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS`); Bug 41 |
| `gen_ai.usage.cache_write.input_tokens` | `tokens.cache.write` | **legacy/transitional** — nonstandard self-invented spelling, dual-emitted with `cache_creation` (same value) for existing dashboards; removal deferred to a future release decision (Bug 41, 2026-11-10) |
| `gen_ai.output.messages` | `[{role:'assistant', parts:[{type:'reasoning', content}…, {type:'text', content}…]}]` JSON | **Gate: `assistantResponses`**; reasoning parts precede text (`reasoning.ended` has no ordinal — no fabricated interleaving); tool calls stay on `execute_tool` spans, never `tool_call` parts |
| `opencode.cost.usd` | `data.cost` | USD per step |
| `opencode.reasoning` | concatenated reasoning chunks | **Gate: `assistantResponses`**; flat mirror of the reasoning parts for attribute-table UIs |
| `openinference.span.kind` | `"LLM"` | |
| `llm.model_name` | `step.model.id` | mirror; omitted with the model id (Bug 48) |
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
| `opencode.agent` | `step.agent` | raw role name, ungated; the template-independent query key |
| `opencode.session.parent_id` | parent session's ID (from the subagent/task link or session registry) | sub-agent sessions only; same key as the invoke_agent container span |
| `opencode.retry.attempt` | stamped from prior `session.retry.scheduled` in the same session | consumed once; also expired when its round closes, so a retry that never ran cannot label the next round's span (Bug 50) |
| `opencode.retry.error` | stamped `"<type>: <message>"` from the same event | same round-bounded lifetime |
| `opencode.wire.capture_id` | consumed frame's recorder-instance UUID (`captureID` in JSONL) | ungated; identifies the recorder, not a host request |
| `opencode.wire.seq` | `wire.seq` of the consumed frame | ungated; correlate to JSONL using `(captureID, seq)`, never `seq` alone across restarts |

The correlation pair is emitted whenever a frame is consumed, including when `wireBody`
is off or the content budget is zero. It identifies the frame selected by the existing
per-session FIFO; it does not change that association policy or the frozen trace/span IDs.
Legacy JSONL records have no `captureID` and cannot be uniquely joined across restarts by
`seq` alone. The new field is additive within wire schema `v: 1`.

Chat duration follows `session.step.started` → `session.step.ended/failed`. Upstream step
settlement includes tool settlement and snapshot work; `session.step.streamed` marks the
provider response-body boundary separately but is not consumed here. Reported chat duration
is therefore a step interval, not pure model-request latency. Record-only decision
(2026-11-10): this wall-clock interval is kept as-is, and
`gen_ai.client.operation.duration{operation=chat}` shares it — read both as step wall-clock
including post-response settlement, not as pure model-request latency.

### 3.3 Tool call (`execute_tool <name>`) — `src/spans.ts`

| Attribute | Source | Notes |
|---|---|---|
| `gen_ai.operation.name` | `"execute_tool"` | |
| `gen_ai.tool.name` | `tool.name` (from `tool.input.started` / `tool.called`) | omitted when no start/called event was observed — `Required` in the semconv, but `"unknown"` is not a tool name: the deviation is preferred over a fabricated value (Bug 48) |
| `gen_ai.tool.call.id` | `toolCallId` | deterministic-id input |
| `gen_ai.tool.type` | — not emitted | the upstream event publishes no tool type; the former constant `"function"` was a guess that would mislabel `datastore`/`extension` tools (`Recommended` "*If available*", Bug 48) |
| `gen_ai.conversation.id` | `sessionID` | |
| `gen_ai.agent.name` | rendered from the `tracing.agentName` template (`{agent}` → `input.agent`), only when `name ∈ {subagent, task}` | identifies the child agent role; default template `"opencode/{agent}"`; omitted when the raw role name is missing or the template is `""` |
| `opencode.agent` | `input.agent` — only when `name ∈ {subagent, task}` | raw role name, ungated; the template-independent query key |
| `opencode.subagent.session_id` | nonempty string `metadata.sessionID` from `tool.success/failed`, only for `subagent` / `task` | ungated child identity; never inferred from arguments or result text |
| `gen_ai.tool.call.arguments` | `JSON.stringify(tool.input)` | **Gate: `toolDetails`** |
| `gen_ai.tool.call.result` | JSON array string: each text part becomes its text string, other parts remain objects | **Gate: `toolContent`** |
| `error.type` | nonempty string `data.error.type`, fallback `"tool_error"` | failure only; same value on tool duration metrics and tool message logs; local unload uses `"interrupted"` with `end_source=plugin_flush` |
| `openinference.span.kind` | `"TOOL"` | |
| `input.value` | same as `gen_ai.tool.call.arguments` | OpenInference mirror; **Gate: `toolDetails`** |
| `output.value` | same as `gen_ai.tool.call.result` | |
| `output.value_original_length` | truncation marker | |

### 3.4 Sub-agent container (`invoke_agent <agent>`) — `src/spans.ts`

| Attribute | Source | Notes |
|---|---|---|
| `gen_ai.operation.name` | `"invoke_agent"` | |
| `gen_ai.provider.name` | — not emitted | same ruling as the turn root: the inference provider is not known at container scope (Bug 48) |
| `gen_ai.agent.name` | rendered from the `tracing.agentName` template (`{agent}` → child session's `agent` field), default `"opencode/{agent}"` | omitted when the raw role name is missing or the template is `""` |
| `opencode.agent` | child session's `agent` field | raw role name, ungated; the template-independent query key |
| `gen_ai.conversation.id` | child `sessionID` | |
| `session.id` / `opencode.session.id` | child `sessionID` | |
| `opencode.session.parent_id` | registering parent's sessionID | |
| `opencode.session.title` / `opencode.session.directory` | from `session.get` on the child | |
| `opencode.interrupt.reason` | `execution.interrupted` `reason` | host enum only (Bug 30); on interrupted sub-agent containers; ABSENT at plugin-unload teardown — the status message carries `interrupted: plugin_unload` instead (Bug 34) |
| `openinference.span.kind` | `"AGENT"` | |

The container's parent is the `execute_tool {subagent,task}` span that registered the attachment
(`src/spans.ts`) when a link is available **and lives in the same trace as the round**. Child chat
spans hang under the container; each child tool span hangs under its issuing chat span.

The round's trace identity is frozen when the container opens (Bug 49), the sub-agent twin of
`TurnState.traceId` for root turns. Before that, every chat/tool/container emission of a round
re-resolved the trace live, so a link or parent turn that appeared mid-round moved only the
container — splitting one round across two traces and leaving the chat's `parentSpanId`
pointing at a span id in a *different* trace (a dangling parent, i.e. an unresolvable parent
claim). A link whose trace differs from the round's is now not used as the parent at all:
`parentSpanId` is omitted rather than asserted.

### 3.5 Compaction — `src/spans.ts`

| Attribute | Source | Notes |
|---|---|---|
| `gen_ai.operation.name` | `"compaction"` | |
| `gen_ai.provider.name` / `gen_ai.request.model` | `session.compaction.ended`'s `data.model` | |
| `gen_ai.response.model` | — not emitted | not independently observed; clean absence until wire-derived observation lands (Bug 43, user decision 2026-11-10) |
| `gen_ai.conversation.id` | `sessionID` | |
| `opencode.compaction.reason` | `compaction.started`'s `data.reason` (default `"unknown"`) | |
| `opencode.compaction.native` | `data.native` boolean | OpenCode's native vs plugin summarizer flag |
| `gen_ai.usage.input_tokens` / `output_tokens` / `reasoning.output_tokens` / `cache_read.input_tokens` / `cache_creation.input_tokens` / `cache_write.input_tokens` | `data.tokens` | same composition as chat spans; cache-write tokens are dual-emitted (Bug 41): standard `cache_creation` plus legacy/transitional `cache_write` (same value, removal deferred) |
| `opencode.cost.usd` | `data.cost` | |
| `openinference.span.kind` | `"LLM"` | |
| `llm.model_name` / `llm.token_count.prompt` / `.completion` / `.total` / `llm.total_cost` | mirrors | same shape as chat |
| `output.value` | the generated summary text | **Gate: `assistantResponses`** |
| `output.value_original_length` | truncation marker | |
| `session.id` / `opencode.session.id` | `sessionID` | |

## 4. Trace resource block (every batch) — `src/otlp.ts`

| Resource attribute | Source |
|---|---|
| `service.name` | `OTEL_SERVICE_NAME` env, else a `service.name` key in the merged resource attributes, else const `"opencode-genai-obs"` |
| `openinference.project.name` | `tracing.project` config (default `"opencode"`) |
| `<custom>` | `tracing.resourceAttributes` merged under `OTEL_RESOURCE_ATTRIBUTES` (env wins per key); builtin keys win on conflicts, except `service.name` |

Metrics and logs build separate resources from configured attributes plus `service.name`;
`tracing.project` is automatically added only to the trace resource.

Instrumentation scope: `{ name: "opencode-genai-obs", version: PLUGIN_VERSION }` — `PLUGIN_VERSION` is the shared `src/version.ts` constant (one version for the traces/metrics/logs scopes so they cannot drift), bumped together with `package.json` at release; no dynamic linkage.

## 5. Deterministic IDs (frozen contract) — `src/ids.ts`, `tests/ids.test.ts`

| Target | Inputs (SHA-256 ingredients) |
|---|---|
| Turn root traceId / spanId | `sessionID × userMessageID` |
| Chat spanId | `assistantMessageID` |
| Tool spanId | `assistantMessageID × toolCallID` |
| Sub-agent container spanId | child `sessionID` |
| Compaction traceId / spanId | `sessionID × compaction.started timestamp` |
| Orphan trace (sub-agent with no parent link) | child `sessionID` |
| Sub-agent round trace | container's frozen `traceId` (Bug 49): the whole round — container, chat, tool spans — resolves through the one value frozen when the round opened, so a container can never land in a trace other than its children's |

The offline replay lane is not implemented yet. Matching IDs can support reconciliation if
the backend supports it; OTLP does not guarantee upsert or deduplication. The shared pipeline
and terminal-event guards suppress duplicate processing in the current instance. They do not
provide durable exactly-once delivery across restarts. Compaction IDs depend on the captured
start timestamp, and synthetic/unknown turns may use an `auto:<created>` key.

## 6. What we deliberately do NOT emit

- `gen_ai.request.temperature` / `top_p` / `max_tokens` / `stop_sequences` — these live
  only inside the wire body (`wire.frame`); surfacing them as attributes would duplicate
  the OpenInference `input.value` payload. This is a plugin choice; standard queryable
  attributes may coexist with captured request content.
- `gen_ai.system_instructions` — same reasoning; the system prompt is part of the wire
  frame (and gated by `contentGates.wireBody`).
- Additional OTel log events (`gen_ai.client.inference.operation.details`,
  `gen_ai.client.operation.exception`) — not emitted. The adapter also supplies empty span
  `events` and `links` arrays; OTLP and the SDK support both.
- Logs (`log_body` on OpenInference) — the `log_body` convention is not used; message
  content ships via the opt-in OTLP logs lane (`src/logs.ts`). Plugin diagnostics go
  only to the local file sink (`~/.local/share/opencode/log/ocg-obs.*.log`), never to
  OTLP. The logs lane shares the `tracing.contentMaxLength` budget: at `0` the record
  body omits the `content` key entirely (an undefined-valued key would serialize as a
  present-but-empty kvlist entry — Bug 28), and every record whose non-empty content was
  withheld or shortened by the budget carries the log-record attribute
  `opencode.content.truncated = true` (envelope-level marker; spans use the
  `*_original_length` markers above instead). The legacy event names (`gen_ai.user.message`,
  `gen_ai.system.message`, `gen_ai.tool.message`, `gen_ai.choice`) are retained despite
  their upstream `@deprecated` status in semantic-conventions 1.43.0 (record-only decision
  2026-11-10).

## 7. Cross-references

- State machine + per-span attribute construction: `src/spans.ts`
- Resource/Scope/Span protobuf encoding: `src/otlp.ts`
- Metrics lane (`gen_ai.client.*` histograms): `src/metrics.ts`
- Logs lane (`gen_ai.*` message events): `src/logs.ts`
- Config knobs feeding each gate: `src/config.ts` (`TracingConfig`)
- On-disk JSONL record schema: `src/types.ts` (`WireRecord`)
- Phoenix annotations (non-OTLP REST extension, orthogonal): `src/annotations.ts`
