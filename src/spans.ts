/**
 * @fileoverview Event-driven span builder (the real-time lane) — a streaming projection
 * of the session event stream into OTel GenAI spans.
 *
 * State machine design (internal design doc):
 * - The prompt hook stashes {messageID, text}; the first step.started opens the turn
 *   (session.created has necessarily passed the SSE pump by then, so root/sub-agent
 *   classification is reliable)
 * - step.ended/failed → emit the chat span immediately (consuming one pending wire
 *   frame to fill input.value)
 * - tool.input.started → record the tool name; tool.called → record input;
 *   success/failed → emit the tool span immediately
 * - text.ended → accumulate message text (chat-span output.value + the root turn's
 *   final-answer candidate)
 * - compaction.started/ended/failed → one standalone trace per compaction run (a
 *   self-contained LLM summarization job outside any turn; model/usage from ended)
 * - retry.scheduled → stamped onto the session's NEXT chat span (the failed step's
 *   span is already emitted by the time the retry is scheduled)
 * - execution.succeeded/failed/interrupted → finish: emit the turn root span (root
 *   session) or the invoke_agent container span (sub-agent session)
 * - Sub-agent attachment: the parent's tool.success registers an attachment point from
 *   metadata.sessionID; every child span inherits the parent turn's traceId and chains
 *   its parentSpanId to the container span
 *
 * Deterministic ids live in ids.ts — a FROZEN contract, byte-identical to the offline
 * replay lane, which relies on them for idempotent dedup. Derivation inputs:
 * turn ids from sessionID × userMessageID; chat/tool ids from assistantMessageID ×
 * toolCallID; session ids from the child sessionID; compaction ids from sessionID ×
 * start timestamp. Exact outputs are pinned by tests/ids.test.ts.
 */

import {
  turnTraceId,
  turnSpanId,
  chatSpanId,
  toolSpanId,
  sessionSpanId,
  orphanTraceId,
  compactionTraceId,
  compactionSpanId,
} from "./ids.js"
import type { SpanRecord, AttrValue } from "./otlp.js"

const KIND_INTERNAL = 1
const KIND_CLIENT = 3

// Session registry cap: sessions are unbounded in long-lived processes; evict the
// oldest past the cap (Map iteration order = insertion order)
const MAX_SESSIONS = 2048

function nano(ms: number): bigint {
  return BigInt(Math.floor(ms)) * 1_000_000n
}

/**
 * Content truncation, three-state (aligned with wire.maxFrameBytes):
 * - limit < 0 (default -1): no truncation
 * - limit === 0: drop the value entirely; only the originalLength is surfaced so callers
 *   still emit `*_original_length` (the attr itself is skipped by attrs() via its
 *   empty-string filter, matching "metadata-only" on the wire JSONL side)
 * - limit > 0: cut at limit chars with a [TRUNCATED] marker; originalLength recorded
 */
function truncate(value: string, limit: number): { value: string; originalLength?: number } {
  if (limit < 0 || value.length <= limit) return { value }
  if (limit === 0) return { value: "", originalLength: value.length }
  return { value: value.slice(0, limit) + `[TRUNCATED original_length=${value.length}]`, originalLength: value.length }
}

/** Skip null/undefined/empty-string values, keep the rest (mirrors adapter._attrs) */
function attrs(...pairs: ReadonlyArray<readonly [string, AttrValue | null | undefined]>): Array<readonly [string, AttrValue]> {
  const out: Array<readonly [string, AttrValue]> = []
  for (const [key, value] of pairs) {
    if (value !== null && value !== undefined && value !== "") out.push([key, value])
  }
  return out
}

/** 40-char preview; undefined for empty input (callers fall back to title/key) */
function preview(text: string | null | undefined): string | undefined {
  const flat = (text ?? "").split(/\s+/).join(" ")
  if (!flat) return undefined
  return flat.length > 40 ? flat.slice(0, 40) + "…" : flat
}

interface TokenUsage {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}

function totalTokens(t: TokenUsage): number {
  return t.input + t.output + t.reasoning + t.cache.read + t.cache.write
}

// ---------------------------------------------------------------------------
// Minimal shapes of event data (only fields we consume — avoids importing opencode internal types)
// ---------------------------------------------------------------------------

interface EventBase {
  readonly type: string
  readonly created: number // epoch ms
  readonly data?: Record<string, unknown>
}

interface SessionInfoLite {
  parentID?: string
  agent?: string
  title?: string
  directory?: string
}

interface TurnState {
  readonly key: string // userMessageID
  readonly traceId: string
  readonly spanId: string
  readonly startedNano: bigint
  readonly inputText: string
  index: number
  agent?: string
  lastAnswer?: string
  lastEndNano: bigint
  spanCount: number
}

interface StepState {
  readonly assistantMessageID: string
  readonly agent: string
  readonly model: { readonly id: string; readonly providerID: string }
  readonly startedNano: bigint
  texts: string[]
  reasoning: string[]
}

interface ToolState {
  readonly callId: string
  readonly assistantMessageID: string | undefined
  name?: string
  input?: Record<string, unknown>
  readonly startedNano: bigint
}

/** One open compaction run (session.compaction.started → ended/failed) */
interface CompactionState {
  /** started-event timestamp (ms) — deterministic discriminator of the run */
  readonly key: string
  readonly reason: string
  readonly startedNano: bigint
}

export interface SpanBuilderOptions {
  /** Fine-grained content gates (defaults in config.ts; mirrors Claude Code's OTEL_LOG_* three-gate semantics) */
  readonly gates: {
    readonly userPrompts: boolean
    readonly assistantResponses: boolean
    readonly toolDetails: boolean
    readonly toolContent: boolean
    readonly wireBody: boolean
  }
  /** Max length (chars) of content attributes, 0 = no truncation */
  readonly contentMaxLength: number
  /** Take one pending wire frame (kind=primary FIFO); undefined when none is left */
  readonly consumeWire: (sessionID: string) => { readonly frame: string; readonly seq: number } | undefined
  /** Fetch the session's latest info asynchronously (fills title/directory at turn close); undefined on failure */
  readonly getSessionInfo?: (sessionID: string) => Promise<SessionInfoLite | undefined>
}

export interface SpanBuilder {
  /** Handle one SSE event (session.* namespace) */
  readonly handleEvent: (event: EventBase) => void
  /** Handle a prompt hook (user message submitted; stashed only, opens no turn) */
  readonly handlePrompt: (sessionID: string, messageID: string, text: string) => void
  /** Finish: flush every in-flight turn/container (called on plugin unload) */
  readonly flushAll: () => Promise<void>
  readonly emit: (span: SpanRecord) => void
}

export function createSpanBuilder(
  options: SpanBuilderOptions,
  emit: (span: SpanRecord) => void,
  log: (msg: string, data?: unknown) => void,
): SpanBuilder {
  /** Session registry: filled on session.created (parentID → sub-agent) */
  const sessions = new Map<string, SessionInfoLite>()
  /** Currently open turn per root session */
  const openTurns = new Map<string, TurnState>()
  /** Prompt-hook stash: held until step.started decides open-a-turn vs ignore (sub-agents) */
  const pendingPrompts = new Map<string, { messageID: string; text: string }>()
  /** Transient step state: assistantMessageID → StepState */
  const steps = new Map<string, StepState>()
  /** Transient tool state: toolCallId → ToolState */
  const tools = new Map<string, ToolState>()
  /** Sub-agent attachment points: child sessionID → { toolSpanId, traceId, parentSid } */
  const links = new Map<string, { toolSpanId: string; traceId: string; parentSid: string }>()
  /** Container-span bookkeeping per sub-agent session (emitted only at close) */
  const containers = new Map<string, { startedNano: bigint; lastEndNano: bigint }>()
  /** Turn counters per root session */
  const turnCounters = new Map<string, number>()
  /** Open compaction runs per session */
  const compactions = new Map<string, CompactionState>()
  /** Retry stamps per session: applied to the next chat span (step.failed emits before retry.scheduled arrives) */
  const pendingRetries = new Map<string, { attempt: number; error?: { type?: string; message?: string } }>()

  const registerSession = (sid: string, info: SessionInfoLite): void => {
    sessions.set(sid, info)
    if (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value
      if (oldest !== undefined && oldest !== sid) {
        sessions.delete(oldest)
        log("session registry cap reached, evicted oldest", { sessionID: oldest })
      }
    }
  }

  /** session.deleted: flush any unfinished turn root, then drop all registry entries for the session (prevents unbounded growth) */
  const dropSession = (sid: string, nowNano: bigint): void => {
    void flushTurnRoot(sid, nowNano) // no-op when no turn is open
    openTurns.delete(sid)
    sessions.delete(sid)
    links.delete(sid)
    containers.delete(sid)
    turnCounters.delete(sid)
    pendingPrompts.delete(sid)
    compactions.delete(sid)
    pendingRetries.delete(sid)
  }

  const isChild = (sid: string): boolean => {
    const link = links.get(sid)
    if (link) return true
    const info = sessions.get(sid)
    return info?.parentID !== undefined
  }

  /** Sub-agent trace inheritance: use the link when known; otherwise the parent's open turn (last resort: open an independent trace) */
  const childTrace = (sid: string): { traceId: string; containerId: string } => {
    const containerId = sessionSpanId(sid)
    const link = links.get(sid)
    if (link) return { traceId: link.traceId, containerId }
    const info = sessions.get(sid)
    const parentTurn = info?.parentID ? openTurns.get(info.parentID) : undefined
    if (parentTurn) return { traceId: parentTurn.traceId, containerId }
    // Fallback: parent turn already closed and no link registered (abnormal ordering) —
    // open our own trace with the container as root
    return { traceId: orphanTraceId(sid), containerId }
  }

  const ensureContainer = (sid: string, nowNano: bigint) => {
    let c = containers.get(sid)
    if (!c) {
      c = { startedNano: nowNano, lastEndNano: nowNano }
      containers.set(sid, c)
    }
    return c
  }

  // --------------------------------------------------------------- turn root

  const flushTurnRoot = async (sid: string, endNano: bigint, error?: { type?: string; message?: string }) => {
    const turn = openTurns.get(sid)
    if (!turn) return
    openTurns.delete(sid)

    // Refresh title/directory at close (the title may have just been generated)
    const info = options.getSessionInfo ? await options.getSessionInfo(sid) : undefined
    const merged: SessionInfoLite = { ...sessions.get(sid), ...info }

    const limit = options.contentMaxLength
    const inputTrunc = options.gates.userPrompts ? truncate(turn.inputText, limit) : undefined
    const outputTrunc = options.gates.assistantResponses && turn.lastAnswer ? truncate(turn.lastAnswer, limit) : undefined

    const span: SpanRecord = {
      traceId: turn.traceId,
      spanId: turn.spanId,
      name: preview(turn.inputText) ?? merged.title ?? turn.key ?? "(empty)",
      kind: KIND_CLIENT,
      startTimeUnixNano: turn.startedNano,
      endTimeUnixNano: endNano > turn.startedNano ? endNano : turn.lastEndNano,
      attributes: attrs(
        ["gen_ai.operation.name", "invoke_agent"],
        ["gen_ai.provider.name", "opencode"],
        ["gen_ai.agent.name", turn.agent ?? merged.agent],
        ["gen_ai.conversation.id", sid],
        ["session.id", sid],
        ["opencode.session.id", sid],
        ["opencode.session.title", merged.title],
        ["opencode.session.directory", merged.directory],
        ["opencode.turn.index", turn.index],
        ["opencode.turn.messages", turn.spanCount],
        // Ungated size signal: lets us reason about prompt growth even when the
        // userPrompts content gate is off (mirrors Claude's interaction.user_prompt_length)
        ["opencode.user_prompt.length", turn.inputText.length],
        ["openinference.span.kind", "AGENT"],
        ["input.value", inputTrunc?.value],
        ["input.value_original_length", inputTrunc?.originalLength],
        ["output.value", outputTrunc?.value],
        ["output.value_original_length", outputTrunc?.originalLength],
      ),
      status: error ? { code: 2, message: `${error.type}: ${error.message}` } : { code: 1 },
    }
    emit(span)
  }

  const openTurn = (sid: string, messageID: string, text: string, nowMs: number, agent?: string) => {
    const index = (turnCounters.get(sid) ?? 0)
    turnCounters.set(sid, index + 1)
    openTurns.set(sid, {
      key: messageID,
      traceId: turnTraceId(sid, messageID),
      spanId: turnSpanId(sid, messageID),
      startedNano: nano(nowMs),
      inputText: text,
      index,
      agent,
      lastEndNano: nano(nowMs),
      spanCount: 0,
    })
  }

  // ------------------------------------------------------------------ events

  const handleEvent = (event: EventBase) => {
    const data = (event.data ?? {}) as Record<string, unknown>
    const sid = data.sessionID as string | undefined
    if (!sid) return

    switch (event.type) {
      case "session.created": {
        registerSession(sid, {
          parentID: data.parentID as string | undefined,
          agent: data.agent as string | undefined,
        })
        if (links.has(sid)) ensureContainer(sid, nano(event.created))
        return
      }

      case "session.deleted": {
        dropSession(sid, nano(event.created))
        return
      }

      case "session.renamed": {
        const info = sessions.get(sid)
        if (info) info.title = data.title as string | undefined
        return
      }

      case "session.step.started": {
        // Open the turn from the stashed prompt on the first step (session.created is
        // known by now, so root/sub-agent classification is reliable)
        if (isChild(sid)) {
          pendingPrompts.delete(sid) // unconsumed sub-agent prompt stashes are dropped
          // The child container may have been flushed at the previous execution close;
          // rebuild on demand
          ensureContainer(sid, nano((data.started as number) ?? event.created))
        } else {
          const pending = pendingPrompts.get(sid)
          if (pending) {
            pendingPrompts.delete(sid)
            const existing = openTurns.get(sid)
            if (existing && existing.key !== pending.messageID) {
              // Previous execution stream never reached succeeded before the new prompt
              // took over: flush that turn root now
              void flushTurnRoot(sid, nano(event.created))
            }
            openTurn(sid, pending.messageID, pending.text, event.created, data.agent as string | undefined)
          } else if (!openTurns.has(sid)) {
            // No stashed prompt (synthetic request/command): fabricate a turn key from
            // the event so spans have somewhere to attach
            openTurn(sid, `auto:${event.created}`, "(auto)", event.created, data.agent as string | undefined)
          }
        }
        const assistantMessageID = typeof data.assistantMessageID === "string" ? data.assistantMessageID : ""
        if (!assistantMessageID) return // malformed event: skip the step (an "undefined" key would cross-corrupt sessions)
        const model = (data.model ?? {}) as { id?: string; providerID?: string }
        steps.set(assistantMessageID, {
          assistantMessageID,
          agent: (data.agent as string) ?? "",
          model: { id: model.id ?? "unknown", providerID: model.providerID ?? "" },
          startedNano: nano((data.started as number) ?? event.created),
          texts: [],
          reasoning: [],
        })
        return
      }

      case "session.text.ended": {
        const step = steps.get(data.assistantMessageID as string)
        if (step) {
          step.texts.push(data.text as string)
          // candidate for the turn's final answer
          const turn = openTurns.get(sid)
          if (turn) turn.lastAnswer = step.texts.join("\n\n")
        }
        return
      }

      case "session.reasoning.ended": {
        const step = steps.get(data.assistantMessageID as string)
        if (step) step.reasoning.push(data.text as string)
        return
      }

      case "session.compaction.started": {
        // One compaction = one trace: a self-contained LLM summarization job outside any turn
        const state: CompactionState = {
          key: String(event.created),
          reason: typeof data.reason === "string" ? data.reason : "unknown",
          startedNano: nano(event.created),
        }
        const previous = compactions.get(sid)
        compactions.set(sid, state)
        // Unterminated predecessor (started without ended/failed): flush it bare so the span is not lost
        if (previous) emitCompactionSpan(sid, previous, {}, nano(event.created), false)
        return
      }

      case "session.compaction.ended":
      case "session.compaction.failed": {
        const state = compactions.get(sid)
        if (!state) return // ended/failed without a recorded start (e.g. plugin loaded mid-run)
        compactions.delete(sid)
        emitCompactionSpan(sid, state, data, nano(event.created), event.type === "session.compaction.failed")
        return
      }

      case "session.retry.scheduled": {
        const attempt = data.attempt
        if (typeof attempt !== "number" || !Number.isFinite(attempt) || attempt <= 0) return // malformed guard
        pendingRetries.set(sid, { attempt, error: data.error as { type?: string; message?: string } | undefined })
        return
      }

      case "session.step.ended":
      case "session.step.failed": {
        const assistantMessageID = typeof data.assistantMessageID === "string" ? data.assistantMessageID : ""
        const step = assistantMessageID ? steps.get(assistantMessageID) : undefined
        if (assistantMessageID) steps.delete(assistantMessageID)
        const endNano = nano(event.created)
        const error = event.type === "session.step.failed" ? (data.error as { type?: string; message?: string } | undefined) : undefined
        // malformed event (no assistantMessageID): skip the chat span — the
        // deterministic id would degrade to a hash of "undefined"
        if (assistantMessageID) emitChatSpan(sid, assistantMessageID, step, data, endNano, error)
        const turn = openTurns.get(sid)
        if (turn) {
          if (endNano > turn.lastEndNano) turn.lastEndNano = endNano
          turn.spanCount += 1
        }
        const container = containers.get(sid)
        if (container && endNano > container.lastEndNano) container.lastEndNano = endNano
        return
      }

      case "session.tool.input.started": {
        const callId = typeof data.id === "string" ? data.id : ""
        if (!callId) return
        tools.set(callId, {
          callId,
          assistantMessageID: typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined,
          name: data.name as string,
          startedNano: nano(event.created),
        })
        return
      }

      case "session.tool.called": {
        const callId = typeof data.id === "string" ? data.id : ""
        if (!callId) return
        const existing = tools.get(callId)
        if (existing) {
          existing.input = data.input as Record<string, unknown>
        } else {
          tools.set(callId, {
            callId,
            assistantMessageID: typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined,
            input: data.input as Record<string, unknown>,
            startedNano: nano(event.created),
          })
        }
        return
      }

      case "session.tool.success":
      case "session.tool.failed": {
        const callId = typeof data.id === "string" ? data.id : ""
        if (!callId) return
        const tool = tools.get(callId)
        tools.delete(callId)
        const endNano = nano(event.created)
        emitToolSpan(sid, callId, tool, data, endNano, event.type === "session.tool.failed")
        const turn = openTurns.get(sid)
        if (turn) {
          if (endNano > turn.lastEndNano) turn.lastEndNano = endNano
          turn.spanCount += 1
        }
        const container = containers.get(sid)
        if (container && endNano > container.lastEndNano) container.lastEndNano = endNano
        return
      }

      case "session.execution.succeeded": {
        if (isChild(sid)) void flushContainer(sid, nano(event.created))
        else void flushTurnRoot(sid, nano(event.created))
        return
      }

      case "session.execution.failed": {
        const error = data.error as { type?: string; message?: string } | undefined
        if (isChild(sid)) void flushContainer(sid, nano(event.created), error)
        else void flushTurnRoot(sid, nano(event.created), error)
        return
      }

      case "session.execution.interrupted": {
        if (isChild(sid)) void flushContainer(sid, nano(event.created), { type: "interrupted", message: (data.reason as string) ?? "" })
        else void flushTurnRoot(sid, nano(event.created), { type: "interrupted", message: (data.reason as string) ?? "" })
        return
      }

      default:
        return
    }
  }

  // ----------------------------------------------------------------- emitters

  const emitChatSpan = (
    sid: string,
    assistantMessageID: string,
    step: StepState | undefined,
    data: Record<string, unknown>,
    endNano: bigint,
    error?: { type?: string; message?: string },
  ) => {
    if (!assistantMessageID) return // defensive: deterministic hashes would collide without ids
    const child = isChild(sid)
    const traceId = child ? childTrace(sid).traceId : openTurns.get(sid)?.traceId
    const parentId = child ? childTrace(sid).containerId : openTurns.get(sid)?.spanId
    if (!traceId || !parentId) return // no turn to attach to (steps should always start first; belt and braces)

    const tokens = data.tokens as TokenUsage | undefined
    const cost = data.cost as number | undefined
    const finish = data.finish as string | undefined
    const model = step?.model ?? { id: "unknown", providerID: "" }
    const texts = step?.texts ?? []
    const reasoning = step?.reasoning ?? []
    const wire = options.consumeWire(sid)
    // retry.scheduled arrived after the failed span was emitted — stamp this (retrying) span instead
    const retry = pendingRetries.get(sid)
    if (retry) pendingRetries.delete(sid)
    const retryError = retry?.error ? `${retry.error.type ?? "error"}: ${retry.error.message ?? ""}` : undefined

    const inputTokens = tokens ? tokens.input + tokens.cache.read + tokens.cache.write : undefined
    const outputTokens = tokens ? tokens.output + tokens.reasoning : undefined

    const limit = options.contentMaxLength
    const outputText = texts.length ? texts.join("\n\n") : undefined
    const wireTrunc = options.gates.wireBody && wire ? truncate(wire.frame, limit) : undefined
    const outputTrunc = options.gates.assistantResponses && outputText ? truncate(outputText, limit) : undefined
    const outputMessages =
      options.gates.assistantResponses && texts.length
        ? truncate(JSON.stringify([{ role: "assistant", parts: texts.map((t) => ({ type: "text", content: t })) }]), limit).value
        : undefined
    const reasoningText =
      options.gates.assistantResponses && reasoning.length ? truncate(reasoning.join("\n\n"), limit).value : undefined

    emit({
      traceId,
      spanId: chatSpanId(assistantMessageID),
      parentSpanId: parentId,
      name: `chat ${model.id}`,
      kind: KIND_CLIENT,
      startTimeUnixNano: step?.startedNano ?? endNano,
      endTimeUnixNano: endNano,
      attributes: attrs(
        ["gen_ai.operation.name", "chat"],
        ["gen_ai.provider.name", model.providerID],
        ["gen_ai.request.model", model.id],
        ["gen_ai.response.model", model.id],
        ["gen_ai.conversation.id", sid],
        ["gen_ai.response.finish_reasons", finish ? JSON.stringify([finish]) : undefined],
        ["gen_ai.usage.input_tokens", inputTokens],
        ["gen_ai.usage.output_tokens", outputTokens],
        ["gen_ai.usage.reasoning.output_tokens", tokens?.reasoning],
        ["gen_ai.usage.cache_read.input_tokens", tokens?.cache.read],
        ["gen_ai.usage.cache_write.input_tokens", tokens?.cache.write],
        ["opencode.cost.usd", cost],
        ["gen_ai.output.messages", outputMessages],
        ["opencode.reasoning", reasoningText],
        // OpenInference mirrors (cross-backend semantic convention, not platform binding)
        ["openinference.span.kind", "LLM"],
        ["llm.model_name", model.id],
        ["llm.token_count.prompt", inputTokens],
        ["llm.token_count.completion", outputTokens],
        ["llm.token_count.total", tokens ? totalTokens(tokens) : undefined],
        ["llm.total_cost", cost],
        // wire body → input.value (native OpenInference; gen_ai.request.raw dropped)
        ["input.value", wireTrunc?.value],
        ["input.value_original_length", wireTrunc?.originalLength],
        ["input.mime_type", wireTrunc ? "application/json" : undefined],
        ["output.value", outputTrunc?.value],
        ["output.value_original_length", outputTrunc?.originalLength],
        ["opencode.message.id", assistantMessageID],
        ["opencode.agent", step?.agent],
        ["opencode.retry.attempt", retry?.attempt],
        ["opencode.retry.error", retryError],
        ["opencode.wire.seq", wireTrunc ? wire?.seq : undefined],
      ),
      status: error ? { code: 2, message: `${error.type ?? "error"}: ${error.message ?? "step failed"}` } : { code: 1 },
    })
  }

  const emitToolSpan = (
    sid: string,
    callId: string,
    tool: ToolState | undefined,
    data: Record<string, unknown>,
    endNano: bigint,
    failed: boolean,
  ) => {
    const child = isChild(sid)
    const traceId = child ? childTrace(sid).traceId : openTurns.get(sid)?.traceId
    if (!traceId) return
    const assistantMessageID =
      tool?.assistantMessageID ?? (typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined)
    // Without assistantMessageID the parent chat-span hash degrades to "undefined" —
    // skip entirely (including sub-agent attachment registration)
    if (!assistantMessageID) return
    // The tool span's parent is the chat span that issued it (deterministic id, so emit order does not matter)
    const parentId = chatSpanId(assistantMessageID)
    const name = tool?.name ?? "unknown"
    const input = tool?.input ?? {}
    const isSubagent = name === "subagent" || name === "task"
    const content = data.content as Array<{ type: string; text?: string }> | undefined
    const result = content?.length
      ? JSON.stringify(content.map((item) => (item.type === "text" ? item.text ?? "" : item)))
      : undefined
    const error = data.error as { type?: string; message?: string } | undefined

    const spanId = toolSpanId(assistantMessageID, callId)

    // Sub-agent attachment: metadata.sessionID → register the attachment point
    if (isSubagent) {
      const metadata = data.metadata as Record<string, unknown> | undefined
      const childSid = metadata?.sessionID as string | undefined
      if (childSid) {
        links.set(childSid, { toolSpanId: spanId, traceId, parentSid: sid })
        ensureContainer(childSid, endNano)
        const info = sessions.get(childSid)
        if (!info?.parentID) registerSession(childSid, { ...info, parentID: sid })
      }
    }

    const limit = options.contentMaxLength
    const argumentsJson = options.gates.toolDetails ? truncate(JSON.stringify(input), limit).value : undefined
    const resultTrunc = options.gates.toolContent && result ? truncate(result, limit) : undefined

    emit({
      traceId,
      spanId,
      parentSpanId: parentId,
      name: `execute_tool ${name}`,
      kind: KIND_INTERNAL,
      startTimeUnixNano: tool?.startedNano ?? endNano,
      endTimeUnixNano: endNano,
      attributes: attrs(
        ["gen_ai.operation.name", "execute_tool"],
        ["gen_ai.tool.name", name],
        ["gen_ai.tool.call.id", callId],
        ["gen_ai.tool.type", "function"],
        ["gen_ai.conversation.id", sid],
        ["gen_ai.agent.name", isSubagent ? (input.agent as string | undefined) : undefined],
        ["gen_ai.tool.call.arguments", argumentsJson],
        ["gen_ai.tool.call.result", resultTrunc?.value],
        ["error.type", failed ? "tool_error" : undefined],
        ["openinference.span.kind", "TOOL"],
        ["input.value", argumentsJson],
        ["output.value", resultTrunc?.value],
        ["output.value_original_length", resultTrunc?.originalLength],
      ),
      status: failed ? { code: 2, message: `${error?.type ?? "error"}: ${error?.message ?? "tool failed"}` } : { code: 1 },
    })
  }

  /**
   * Compaction run → one standalone trace. `ended` carries model/native/text/cost/tokens,
   * `failed` carries error/cost/tokens (opencode session.compaction.* schema); both are
   * read defensively, so an unterminated flush (empty data) still emits a bare span.
   */
  const emitCompactionSpan = (
    sid: string,
    state: CompactionState,
    data: Record<string, unknown>,
    endNano: bigint,
    failed: boolean,
  ) => {
    const model = (data.model ?? {}) as { id?: string; providerID?: string }
    const tokens = data.tokens as TokenUsage | undefined
    const cost = data.cost as number | undefined
    const error = data.error as { type?: string; message?: string } | undefined
    const inputTokens = tokens ? tokens.input + tokens.cache.read + tokens.cache.write : undefined
    const outputTokens = tokens ? tokens.output + tokens.reasoning : undefined
    const summaryTrunc =
      options.gates.assistantResponses && typeof data.text === "string" ? truncate(data.text, options.contentMaxLength) : undefined

    emit({
      traceId: compactionTraceId(sid, state.key),
      spanId: compactionSpanId(sid, state.key),
      name: "compaction",
      kind: KIND_CLIENT,
      startTimeUnixNano: state.startedNano,
      endTimeUnixNano: endNano,
      attributes: attrs(
        ["gen_ai.operation.name", "compaction"],
        ["gen_ai.provider.name", model.providerID],
        ["gen_ai.request.model", model.id],
        ["gen_ai.response.model", model.id],
        ["gen_ai.conversation.id", sid],
        ["opencode.compaction.reason", state.reason],
        ["opencode.compaction.native", data.native as boolean | undefined],
        ["gen_ai.usage.input_tokens", inputTokens],
        ["gen_ai.usage.output_tokens", outputTokens],
        ["gen_ai.usage.reasoning.output_tokens", tokens?.reasoning],
        ["gen_ai.usage.cache_read.input_tokens", tokens?.cache.read],
        ["gen_ai.usage.cache_write.input_tokens", tokens?.cache.write],
        ["opencode.cost.usd", cost],
        // OpenInference mirrors (same set as chat spans)
        ["openinference.span.kind", "LLM"],
        ["llm.model_name", model.id],
        ["llm.token_count.prompt", inputTokens],
        ["llm.token_count.completion", outputTokens],
        ["llm.token_count.total", tokens ? totalTokens(tokens) : undefined],
        ["llm.total_cost", cost],
        ["output.value", summaryTrunc?.value],
        ["output.value_original_length", summaryTrunc?.originalLength],
        ["session.id", sid],
        ["opencode.session.id", sid],
      ),
      status: failed ? { code: 2, message: `${error?.type ?? "error"}: ${error?.message ?? "compaction failed"}` } : { code: 1 },
    })
  }

  /** Sub-agent session close: emit the invoke_agent container span */
  const flushContainer = async (sid: string, endNano: bigint, error?: { type?: string; message?: string }) => {
    const container = containers.get(sid)
    if (!container) return // nothing ever produced a step/tool (empty session) — skip
    containers.delete(sid)
    const link = links.get(sid)
    const traceId = link?.traceId ?? childTrace(sid).traceId
    const info = options.getSessionInfo ? await options.getSessionInfo(sid) : sessions.get(sid)

    emit({
      traceId,
      spanId: sessionSpanId(sid),
      parentSpanId: link?.toolSpanId,
      name: `invoke_agent ${info?.agent ?? "opencode"}`,
      kind: KIND_CLIENT,
      startTimeUnixNano: container.startedNano,
      endTimeUnixNano: endNano > container.lastEndNano ? endNano : container.lastEndNano,
      attributes: attrs(
        ["gen_ai.operation.name", "invoke_agent"],
        ["gen_ai.provider.name", "opencode"],
        ["gen_ai.agent.name", info?.agent],
        ["gen_ai.conversation.id", sid],
        ["session.id", sid],
        ["opencode.session.id", sid],
        ["opencode.session.parent_id", link?.parentSid ?? info?.parentID],
        ["opencode.session.title", info?.title],
        ["opencode.session.directory", info?.directory],
        ["openinference.span.kind", "AGENT"],
      ),
      status: error ? { code: 2, message: `${error.type}: ${error.message}` } : { code: 1 },
    })
  }

  return {
    handleEvent,
    handlePrompt(sessionID, messageID, text) {
      pendingPrompts.set(sessionID, { messageID, text })
    },
    async flushAll() {
      const now = nano(Date.now())
      for (const sid of [...openTurns.keys()]) await flushTurnRoot(sid, now)
      for (const sid of [...containers.keys()]) await flushContainer(sid, now)
      for (const [sid, state] of [...compactions]) emitCompactionSpan(sid, state, {}, now, false)
    },
    emit,
  }
}
