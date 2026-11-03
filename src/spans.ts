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
 *
 * Standing semantic heuristics are labeled at their sites and indexed in TODO.md (AGENTS.md heuristic policy).
 */

import { cutUtf8Bytes } from "./truncate.js"
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
import type { MetricObservation } from "./metrics.js"
import type { LogObservation } from "./logs.js"

const KIND_INTERNAL = 1
const KIND_CLIENT = 3

// Session registry cap: sessions are unbounded in long-lived processes; evict the
// oldest past the cap (Map iteration order = insertion order)
const MAX_SESSIONS = 2048

function nano(ms: number): bigint {
  return BigInt(Math.floor(ms)) * 1_000_000n
}

/**
 * Content truncation, three-state (aligned with wire.maxFrameBytes), measured in UTF-8 bytes
 * so the cap matches backend per-attribute byte limits:
 * - limit < 0 (default -1): no truncation
 * - limit === 0: drop the value entirely; only the originalLength (bytes) is surfaced so
 *   callers still emit `*_original_length` (the attr itself is skipped by attrs() via its
 *   empty-string filter, matching "metadata-only" on the wire JSONL side)
 * - limit > 0: cut at the limit's byte budget (character-boundary safe via cutUtf8Bytes)
 *   with a [TRUNCATED original_length=<bytes>] marker; originalLength recorded in bytes
 */
function truncate(value: string, limit: number): { value: string; originalLength?: number } {
  if (limit < 0) return { value }
  const bytes = Buffer.byteLength(value, "utf-8")
  if (bytes <= limit) return { value }
  if (limit === 0) return { value: "", originalLength: bytes }
  return { value: cutUtf8Bytes(value, limit) + `[TRUNCATED original_length=${bytes}]`, originalLength: bytes }
}

/** Reassemble text segments in ordinal order (arrival order may differ) */
function orderedTexts(texts: Map<number, string>): string[] {
  return [...texts.entries()].sort(([a], [b]) => a - b).map(([, text]) => text)
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
  /**
   * Durable-log position of this event within its aggregate (the envelope's
   * durable.seq): present on every state-transition session.* event, absent on
   * ephemeral ones (text.delta, usage.updated, tool.progress). It is a log
   * position, not a delivery order — round discrimination via seq comparison
   * stays correct under late/out-of-order delivery (Bug 23).
   */
  readonly seq?: number
}

interface SessionInfoLite {
  parentID?: string
  agent?: string
  title?: string
  directory?: string
}

/** Turn origin: a real prompt hook ("user"), a consumed wakeup event ("synthetic"), or neither ("unknown") */
type TurnOrigin = "user" | "synthetic" | "unknown"

interface TurnState {
  readonly key: string // userMessageID
  readonly traceId: string
  readonly spanId: string
  readonly startedNano: bigint
  readonly inputText: string
  /** Where inputText came from — decides user attribution (gen_ai.user.message, prompt length) */
  readonly origin: TurnOrigin
  /** Durable high-water at turn open — the round identity this turn belongs to (Bug 23) */
  readonly roundSeq?: number
  index: number
  agent?: string
  lastAnswer?: string
  lastEndNano: bigint
  spanCount: number
}

interface StepState {
  readonly assistantMessageID: string
  readonly sessionID: string
  readonly agent: string
  readonly model: { readonly id: string; readonly providerID: string }
  readonly startedNano: bigint
  /** text segments keyed by their protocol ordinal — reassembled in ordinal order, not arrival order */
  texts: Map<number, string>
  reasoning: string[]
  /**
   * Set when the execution round was interrupted mid-step: the step keeps its state
   * (a late step.ended still emits its chat span) but must stop advertising propagation
   * coordinates — its span id would otherwise be injected as a phantom traceparent
   * under the NEXT turn's trace (Bug 19).
   */
  interrupted?: boolean
}

interface ToolState {
  readonly callId: string
  readonly sessionID: string
  readonly assistantMessageID: string | undefined
  name?: string
  input?: Record<string, unknown>
  readonly startedNano: bigint
}

/** One open compaction run (session.compaction.started → ended/failed) */
interface CompactionState {
  /**
   * HEURISTIC(upstream-gap): invented run identity = the started event's ms
   * timestamp (this key). Upstream gap: session.compaction.started/ended carry
   * only {sessionID, reason} — ended never references its started, and no run id
   * exists upstream, so this key is the only run discriminator. FROZEN: the key
   * feeds the deterministic id formulas (opencode-compaction:<sid>:<created> /
   * opencode-compaction-span:<sid>:<created>, ids.ts), so replacing it (e.g. with
   * durable.seq) would change every future compaction span id — do not change
   * without an explicit id-continuity decision. Migration: upstream adds a
   * run/correlation id. Approved: user decision 2026-11-01.
   */
  readonly key: string
  readonly reason: string
  readonly startedNano: bigint
  /** durable.seq of the started event: an older started/terminal below it belongs to a superseded run (Bug 24); undefined = seq-less envelope */
  readonly seq?: number
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
  /** Byte budget for content attributes: -1 = no truncation, 0 = metadata-only (see tracing.contentMaxLength) */
  readonly contentMaxLength: number
  /** Take one pending wire frame (kind=primary FIFO); undefined when none is left */
  readonly consumeWire: (sessionID: string) => { readonly frame: string; readonly seq: number } | undefined
  /** Fetch the session's latest info asynchronously (fills title/directory at turn close); undefined on failure */
  readonly getSessionInfo?: (sessionID: string) => Promise<SessionInfoLite | undefined>
  /** GenAI-semconv metric observations (token usage + operation duration); undefined disables metrics */
  readonly observe?: (obs: MetricObservation) => void
  /** GenAI-semconv message events (user/system/tool/choice); undefined disables the logs lane */
  readonly emitLogEvent?: (obs: LogObservation) => void
}

export interface SpanBuilder {
  /** Handle one SSE event (session.* namespace) */
  readonly handleEvent: (event: EventBase) => void
  /** Handle a prompt hook (user message submitted; stashed only, opens no turn) */
  readonly handlePrompt: (sessionID: string, messageID: string, text: string) => void
  /** Finish: flush every in-flight turn/container (called on plugin unload) */
  readonly flushAll: () => Promise<void>
  /**
   * W3C trace-context coordinates of the session's in-flight chat step (the span that
   * the current LLM request will become). Undefined between steps — callers must not
   * guess. Used by the model.request hook to inject traceparent.
   */
  readonly activeChatContext: (
    sessionID: string,
  ) => { readonly traceId: string; readonly spanId: string; readonly agent: string; readonly model: { readonly id: string; readonly providerID: string } } | undefined
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
  /**
   * Wakeup stash (Bug 25): text of the last synthetic wakeup for a session — from
   * `session.synthetic` or a synthetic `session.inbox.enqueued` item — held until
   * step.started opens the round it woke. Last-write-wins; consumed (deleted) by the
   * first turn it opens, and a stashed user prompt wins the round instead.
   */
  const pendingWakes = new Map<string, { text: string }>()
  /** Transient step state: assistantMessageID → StepState */
  const steps = new Map<string, StepState>()
  /**
   * Terminal-step registry: assistantMessageIDs that already emitted a chat span via
   * step.ended/failed. opencode V2 may fan the same event out to multiple plugin
   * instances (see DEVtheOPS AGENTS.md) — without this, a duplicate step.ended would
   * re-emit the span and double-count metrics/logs (Bug 13). Nested by sessionID so
   * session.deleted can purge it (terminal registries grow monotonically until purged).
   */
  const endedSteps = new Map<string, Set<string>>()
  /**
   * Terminal-tool registry: toolCallIds that already emitted their execute_tool span.
   * The endedSteps twin (Bug 16): a redelivered tool.success/failed would emit a
   * degraded second span (same deterministic id, name "unknown", zero duration) plus a
   * non-dedupable log record (log record ids are SDK-generated). Nested by sessionID
   * so session.deleted can purge it.
   */
  const endedTools = new Map<string, Set<string>>()
  /** Transient tool state: toolCallId → ToolState */
  const tools = new Map<string, ToolState>()
  /** Sub-agent attachment points: child sessionID → { toolSpanId, traceId, parentSid } */
  const links = new Map<string, { toolSpanId: string; traceId: string; parentSid: string }>()
  /** Container-span bookkeeping per sub-agent session (emitted only at close); roundSeq = durable high-water at creation (Bug 23) */
  const containers = new Map<string, { startedNano: bigint; lastEndNano: bigint; roundSeq?: number }>()
  /** Turn counters per root session */
  const turnCounters = new Map<string, number>()
  /** Open compaction runs per session */
  const compactions = new Map<string, CompactionState>()
  /** Retry stamps per session: applied to the next chat span (step.failed emits before retry.scheduled arrives) */
  const pendingRetries = new Map<string, { attempt: number; error?: { type?: string; message?: string } }>()
  /**
   * Per-session durable high-water (Bug 23): the newest durable.seq seen for the
   * aggregate. Turns/containers capture it at creation as their round identity; a
   * terminal below it belongs to a superseded round. Tracking the high-water (not
   * just the last execution.started's seq) subsumes started-tracking AND survives
   * a missed execution.started (subscribe gap) — the turn-opening event's own seq
   * is already included.
   */
  const seqHighWater = new Map<string, number>()

  const registerSession = (sid: string, info: SessionInfoLite): void => {
    sessions.set(sid, info)
    if (sessions.size <= MAX_SESSIONS) return
    // 3-tier victim rule (Bug 29), oldest-first within each tier: (1) an idle root —
    // never a session with an open round, and children last among the idle because
    // their registry entry carries the parentID that anchors sub-agent lineage across
    // rounds; (2) any idle entry — the fallback that keeps MAX_SESSIONS a hard cap when
    // no idle root exists (e.g. 2048 finished-but-undeleted child sessions); (3) any
    // entry at all — degenerate (everything has an open round), the cap still wins.
    // Blast radius of a wrong victim: an in-flight session loses its turn/container, an
    // idle child loses its lineage and degrades to a root session on its next round.
    const hasOpenRound = (k: string): boolean => openTurns.has(k) || containers.has(k) || compactions.has(k)
    const childAnchored = (k: string): boolean => sessions.get(k)?.parentID !== undefined || links.has(k)
    const pickVictim = (skipBusy: boolean, skipChildren: boolean): string | undefined => {
      for (const k of sessions.keys()) {
        if (k === sid) continue
        if (skipBusy && hasOpenRound(k)) continue
        if (skipChildren && childAnchored(k)) continue
        return k
      }
      return undefined
    }
    const victim = pickVictim(true, true) ?? pickVictim(true, false) ?? pickVictim(false, false)
    if (victim !== undefined) {
      sessions.delete(victim)
      log("session registry cap reached, evicted session", { sessionID: victim })
    }
  }

  /** session.deleted: flush any unfinished turn root, then drop all registry entries for the session (prevents unbounded growth) */
  /**
   * Round-over in-flight cleanup (Bug 19): tools can never attach after the round's flush
   * (traceId lookup fails), so they are dropped. Steps are dropped on succeeded/failed (a
   * still-open step missed its terminal) but only MARKED on interrupted — see the label.
   *
   * HEURISTIC(upstream-gap): an UNVERIFIED guess at approval (2026-11-01) — refuted for live ordering by
   * upstream verification (2026-11-03): step terminals publish inside an uninterruptible block
   * (runner/step.ts:140-283, Step.Ended at :247-258); execution.interrupted publishes only afterwards, from
   * the settled hook (execution.ts:129-133, run-coordinator.ts:96-100) — in live delivery step.ended ALWAYS
   * precedes interrupted; sole no-terminal path: cancellation before the assistant started (step.ts:147-148),
   * so the mark branch never fires live. RETAINED by explicit user decision (2026-11-03) as cheap gap/replay
   * defense (bounded: ~20 lines, tested, no live-path branching cost beyond this dual-mode purge) — a
   * consciously-accepted exception to AGENTS.md "live capture first": defense, not a live-path requirement.
   */
  const purgeInFlight = (sid: string, stepsAction: "purge" | "mark"): void => {
    for (const [id, tool] of tools) if (tool.sessionID === sid) tools.delete(id)
    if (stepsAction === "purge") {
      for (const [id, step] of steps) if (step.sessionID === sid) steps.delete(id)
    } else {
      for (const step of steps.values()) if (step.sessionID === sid) step.interrupted = true
    }
  }

  const dropSession = (sid: string, nowNano: bigint): void => {
    void flushTurnRoot(sid, nowNano) // no-op when no turn is open
    openTurns.delete(sid)
    sessions.delete(sid)
    links.delete(sid)
    containers.delete(sid)
    turnCounters.delete(sid)
    pendingPrompts.delete(sid)
    pendingWakes.delete(sid)
    compactions.delete(sid)
    pendingRetries.delete(sid)
    endedSteps.delete(sid)
    endedTools.delete(sid)
    seqHighWater.delete(sid)
    purgeInFlight(sid, "purge")
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
      c = { startedNano: nowNano, lastEndNano: nowNano, roundSeq: seqHighWater.get(sid) }
      containers.set(sid, c)
    }
    return c
  }

  // --------------------------------------------------------------- turn root

  const flushTurnRoot = async (sid: string, endNano: bigint, error?: { type?: string; message?: string }) => {
    const turn = openTurns.get(sid)
    if (!turn) return
    openTurns.delete(sid)
    // Bug 26: a wake stashed while THIS turn was open was a mid-turn continuation of
    // this round (incomplete-stream / output-limit continuation, llm.ts:333,364) — it
    // must not survive into the next round. Live producers of a NEXT-round wake
    // (subagent-completion, restart continuation) only ever fire while the parent is
    // idle (no open turn), so deleting at turn close never discards a legitimate wake
    // under live ordering (AGENTS.md live-first: no replay-only complexity). flushAll
    // reaching here is unload teardown — the builder state dies with the instance, so
    // the delete is inert there. Child sessions need no twin in flushContainer: their
    // step.started opens containers, never a turn, so they never consume wakes.
    pendingWakes.delete(sid)

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
        // Wakeup origin marker — present only on non-user rounds: the wakeup text is
        // real upstream data (session.synthetic / synthetic session.inbox.enqueued),
        // surfacing the origin on the turn root makes wakeup rounds queryable (Bug 25)
        ["opencode.turn.wakeup", turn.origin === "user" ? undefined : turn.origin],
        // Ungated size signal (UTF-8 bytes, same unit as the truncation budget): lets us
        // reason about prompt growth even when the userPrompts content gate is off
        // (mirrors Claude's interaction.user_prompt_length). User rounds only — a
        // synthetic/unknown round has no user prompt to measure (Bug 25)
        ["opencode.user_prompt.length", turn.origin === "user" ? Buffer.byteLength(turn.inputText, "utf-8") : undefined],
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

  const openTurn = (sid: string, messageID: string, text: string, nowMs: number, origin: TurnOrigin, agent?: string) => {
    const index = (turnCounters.get(sid) ?? 0)
    turnCounters.set(sid, index + 1)
    const traceId = turnTraceId(sid, messageID)
    const spanId = turnSpanId(sid, messageID)
    openTurns.set(sid, {
      key: messageID,
      traceId,
      spanId,
      startedNano: nano(nowMs),
      inputText: text,
      origin,
      roundSeq: seqHighWater.get(sid),
      index,
      agent,
      lastEndNano: nano(nowMs),
      spanCount: 0,
    })
    // gen_ai.user.message — ONLY a real prompt hook is user attribution; synthetic
    // wakeups and unknown-origin rounds never emit one (Bug 25 removed the fabricated
    // "(auto)" pseudo-prompt that used to leak here). Gated by userPrompts
    // (undefined content = metadata-only event).
    if (origin === "user") {
      options.emitLogEvent?.({ event: "user", sessionID: sid, timeMs: nowMs, traceId, spanId, content: options.gates.userPrompts ? text : undefined })
    }
  }

  // ------------------------------------------------------------------ events

  /**
   * Bug 23 guard: a terminal whose durable.seq predates the open turn's (root
   * sessions) / open container's (sub-agent sessions) round is a superseded
   * round's late delivery — it must not flush the current round's state. A
   * same-round terminal always carries a higher seq than the opening event (the
   * durable log is strictly monotonic per aggregate and the terminal is the
   * round's last entry), so a legitimate terminal is never masked. Comparing log
   * positions makes the decision independent of delivery order.
   *
   * Graceful degradation: when either side lacks a seq (ephemeral envelope
   * variants, older hosts) the guard is inactive and the pre-Bug-23 behavior
   * applies — durable.seq IS the upstream round-discrimination mechanism, so
   * this fallback is mechanism-aligned, not a semantic heuristic.
   */
  const staleTerminal = (sid: string, seq: number | undefined): boolean => {
    if (seq === undefined) return false
    const roundSeq = openTurns.get(sid)?.roundSeq ?? containers.get(sid)?.roundSeq
    return roundSeq !== undefined && seq < roundSeq
  }

  const handleEvent = (event: EventBase) => {
    const data = (event.data ?? {}) as Record<string, unknown>
    const sid = data.sessionID as string | undefined
    if (!sid) return
    // High-water first, before the switch: the turn/container opened by this very
    // event must capture a high-water that already includes the event's own seq
    if (event.seq !== undefined) seqHighWater.set(sid, Math.max(seqHighWater.get(sid) ?? event.seq, event.seq))

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

      case "session.synthetic": {
        // Wakeup stash (Bug 25): a synthetic round opener (external Session.synthetic
        // route, restart continuation, instruction injection, stream continuation) —
        // the text is the real wakeup message the round will run on
        if (typeof data.text === "string") pendingWakes.set(sid, { text: data.text })
        return
      }

      case "session.inbox.enqueued": {
        // Wakeup stash (Bug 25): subagent-completion wakeups enqueue a synthetic inbox
        // item instead of firing any prompt; non-synthetic items are real user input
        // captured by the prompt hook — not stashed here
        const item = data.item as { type?: string; payload?: { text?: unknown } } | undefined
        if (item?.type === "synthetic" && typeof item.payload?.text === "string") {
          pendingWakes.set(sid, { text: item.payload.text })
        }
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
            pendingWakes.delete(sid) // the user prompt wins the round; the wake is stale
            const existing = openTurns.get(sid)
            if (existing && existing.key !== pending.messageID) {
              // Previous execution stream never reached succeeded before the new prompt
              // took over: flush that turn root now
              void flushTurnRoot(sid, nano(event.created))
            }
            openTurn(sid, pending.messageID, pending.text, event.created, "user", data.agent as string | undefined)
          } else if (!openTurns.has(sid)) {
            // HEURISTIC(upstream-gap): invented semantics = the turn identity only:
            // this branch keys a turn root `auto:<created>` when a step.started arrives
            // with no stashed prompt. Everything the round WAS attributed to is now
            // real upstream data (Bug 25): the fabricated user message "(auto)" was
            // removed, and the wakeup text is consumed from the events that actually
            // fire — `session.synthetic` and `session.inbox.enqueued` with a synthetic
            // item (subagent-completion wakeup, `Session.synthetic` external route,
            // restart continuation ("Continuing after server restart", restart.ts:93),
            // instruction injection (instructions.ts:75), stream continuation
            // (llm.ts:333,364)). The earlier "session.synthetic empirically NEVER
            // fires" claim (live-probe 2026-11-01) was wrong — the probe just didn't
            // exercise those paths; a follow-up probe verified the firing contexts
            // (/tmp/opencode/syn-probe.jsonl). Remaining gap: no upstream marker ties
            // a round to its wakeup event, so `auto:<created>` stays the turn key.
            // Migration: upstream documents a round-origin marker (opencode #47701 is
            // the live thread for the lifecycle contract).
            // Approved: user decision 2026-11-01.
            const wake = pendingWakes.get(sid)
            pendingWakes.delete(sid)
            openTurn(sid, `auto:${event.created}`, wake?.text ?? "", event.created, wake ? "synthetic" : "unknown", data.agent as string | undefined)
          }
        }
        const assistantMessageID = typeof data.assistantMessageID === "string" ? data.assistantMessageID : ""
        if (!assistantMessageID) return // malformed event: skip the step (an "undefined" key would cross-corrupt sessions)
        const model = (data.model ?? {}) as { id?: string; providerID?: string }
        steps.set(assistantMessageID, {
          assistantMessageID,
          sessionID: sid,
          agent: (data.agent as string) ?? "",
          model: { id: model.id ?? "unknown", providerID: model.providerID ?? "" },
          startedNano: nano((data.started as number) ?? event.created),
          texts: new Map(),
          reasoning: [],
        })
        return
      }

      case "session.text.ended": {
        const step = steps.get(data.assistantMessageID as string)
        if (step) {
          const ordinal = typeof data.ordinal === "number" ? data.ordinal : step.texts.size
          step.texts.set(ordinal, data.text as string)
          // candidate for the turn's final answer (ordinal-ordered)
          const turn = openTurns.get(sid)
          if (turn) turn.lastAnswer = orderedTexts(step.texts).join("\n\n")
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
        // Stale redelivery (Bug 24): a started below the session's durable high-water belongs
        // to an already-superseded run — it must neither bare-flush a newer open run nor
        // reopen a finished one
        if (event.seq !== undefined && event.seq < (seqHighWater.get(sid) ?? event.seq)) {
          log("stale compaction.started ignored", { sessionID: sid, seq: event.seq })
          return
        }
        const state: CompactionState = {
          key: String(event.created),
          reason: typeof data.reason === "string" ? data.reason : "unknown",
          startedNano: nano(event.created),
          seq: event.seq,
        }
        const previous = compactions.get(sid)
        compactions.set(sid, state)
        // Unterminated predecessor (started without ended/failed): flush it bare so the span is not lost.
        // A redelivered started is NOT a predecessor — same created timestamp → same run key; a bare
        // flush would emit a premature span with the same deterministic id, and first-write-wins
        // backends would keep the bare one (Bug 17)
        if (previous && previous.key !== state.key) emitCompactionSpan(sid, previous, {}, nano(event.created), false)
        return
      }

      case "session.compaction.ended":
      case "session.compaction.failed": {
        const state = compactions.get(sid)
        if (!state) return // ended/failed without a recorded start (e.g. plugin loaded mid-run)
        // Stale terminal (Bug 24): an ended/failed below the open run's started seq belongs
        // to a superseded run — it must not pop and flush the newer state
        if (state.seq !== undefined && event.seq !== undefined && event.seq < state.seq) {
          log("stale compaction terminal ignored", { sessionID: sid, seq: event.seq })
          return
        }
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
        // Idempotency: a duplicate terminal event for the same assistant message is a
        // no-op — the span/metrics/logs were already emitted on first delivery.
        if (assistantMessageID) {
          const ended = endedSteps.get(sid) ?? new Set<string>()
          if (ended.has(assistantMessageID)) return
          ended.add(assistantMessageID)
          endedSteps.set(sid, ended)
        }
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
          sessionID: sid,
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
            sessionID: sid,
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
        // Idempotency (Bug 16): the bus is at-least-once — a redelivered terminal must be
        // a no-op before any side effect (span, log event, spanCount, lastEndNano)
        const seen = endedTools.get(sid) ?? new Set<string>()
        if (seen.has(callId)) return
        seen.add(callId)
        endedTools.set(sid, seen)
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

      case "session.execution.succeeded":
      case "session.execution.failed": {
        // Superseded round's late terminal (Bug 23): no flush, no purge, no state
        // mutation — the current round keeps its turn/container and in-flight steps
        if (staleTerminal(sid, event.seq)) {
          log("stale round terminal ignored", { sessionID: sid, type: event.type, seq: event.seq })
          return
        }
        const error = event.type === "session.execution.failed" ? (data.error as { type?: string; message?: string } | undefined) : undefined
        if (isChild(sid)) void flushContainer(sid, nano(event.created), error)
        else void flushTurnRoot(sid, nano(event.created), error)
        // Round over: tools can no longer attach anywhere (the turn/container is flushed),
        // and a step still in flight at succeeded/failed is a missed terminal — purge both
        purgeInFlight(sid, "purge")
        return
      }

      case "session.execution.interrupted": {
        // Superseded round's late terminal (Bug 23): same early return as above
        if (staleTerminal(sid, event.seq)) {
          log("stale round terminal ignored", { sessionID: sid, type: event.type, seq: event.seq })
          return
        }
        if (isChild(sid)) void flushContainer(sid, nano(event.created), { type: "interrupted", message: (data.reason as string) ?? "" })
        else void flushTurnRoot(sid, nano(event.created), { type: "interrupted", message: (data.reason as string) ?? "" })
        // The interrupted step stays answerable to a late step.ended (its chat span still
        // emits), but its propagation coordinates die with the round (Bug 19)
        purgeInFlight(sid, "mark")
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
    const texts = step ? orderedTexts(step.texts) : []
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
    // gen_ai.output.messages follows the semconv ChatMessage schema: reasoning is a standard
    // part type. session.reasoning.ended carries no ordinal, so reasoning parts precede the
    // text parts — never a fabricated interleaving. Tool calls stay out of the parts array:
    // they are invisible at step level and already fully captured on execute_tool spans.
    // HEURISTIC(upstream-gap): reasoning segments concatenate in ARRIVAL order (the reasoning: string[] on the step
    // state, pushed at session.reasoning.ended) and we never fabricate an interleaving with the text parts.
    // Upstream gap: text segments carry a protocol ordinal, reasoning events carry no ordinal/index — the
    // concatenation order has no contract guarantee. VERIFIED (2026-11-03): the bus preserves per-subscription
    // publish order (bus.ts:751-782), so live arrival order equals generation order; the no-ordinal gap is
    // replay-only. Migration: upstream adds an index to reasoning segments. Approved: user decision 2026-11-01.
    const outputParts = [
      ...reasoning.map((chunk) => ({ type: "reasoning", content: chunk })),
      ...texts.map((text) => ({ type: "text", content: text })),
    ]
    const outputMessages =
      options.gates.assistantResponses && outputParts.length
        ? truncate(JSON.stringify([{ role: "assistant", parts: outputParts }]), limit).value
        : undefined
    // flat mirror of the reasoning parts — one searchable string for attribute-table UIs
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
        ["input.mime_type", wireTrunc?.value ? "application/json" : undefined],
        ["output.value", outputTrunc?.value],
        ["output.value_original_length", outputTrunc?.originalLength],
        ["opencode.message.id", assistantMessageID],
        ["opencode.agent", step?.agent],
        // Sub-agent lineage: which session spawned this one — same key as the invoke_agent
        // container span. Links registered by the subagent/task tool carry the authoritative
        // parentSid; fall back to the session registry's parentID (covers sessions whose
        // tool link raced ahead of session.created). Absent on root sessions.
        ["opencode.session.parent_id", child ? (links.get(sid)?.parentSid ?? sessions.get(sid)?.parentID) : undefined],
        ["opencode.retry.attempt", retry?.attempt],
        ["opencode.retry.error", retryError],
        ["opencode.wire.seq", wireTrunc ? wire?.seq : undefined],
      ),
      status: error ? { code: 2, message: `${error.type ?? "error"}: ${error.message ?? "step failed"}` } : { code: 1 },
    })

    // gen_ai.client.* metrics — input includes cache read/write (billable input, same
    // aggregation as the span); a failed step's duration carries error.type
    if (options.observe && step) {
      if (inputTokens !== undefined) options.observe({ metric: "token", tokenType: "input", value: inputTokens, provider: model.providerID, model: model.id })
      if (outputTokens !== undefined) options.observe({ metric: "token", tokenType: "output", value: outputTokens, provider: model.providerID, model: model.id })
      options.observe({
        metric: "duration",
        operation: "chat",
        durationNano: endNano > step.startedNano ? endNano - step.startedNano : 0n,
        provider: model.providerID,
        model: model.id,
        errorType: error ? (error.type ?? "error") : undefined,
      })
    }

    // gen_ai.choice (the step's completion) + gen_ai.system.message (best-effort from
    // the wire frame). Both anchor at this chat span's deterministic context.
    if (options.emitLogEvent) {
      const timeMs = Number(endNano / 1_000_000n)
      options.emitLogEvent({
        event: "choice",
        sessionID: sid,
        timeMs,
        traceId,
        spanId: chatSpanId(assistantMessageID),
        provider: model.providerID,
        model: model.id,
        finishReason: finish,
        content: options.gates.assistantResponses && outputText ? outputText : undefined,
      })
      if (wire) {
        options.emitLogEvent({
          event: "system",
          sessionID: sid,
          timeMs,
          traceId,
          spanId: chatSpanId(assistantMessageID),
          frame: wire.frame,
          gated: !options.gates.wireBody,
        })
      }
    }
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

    if (options.observe && tool) {
      options.observe({
        metric: "duration",
        operation: "execute_tool",
        durationNano: endNano > tool.startedNano ? endNano - tool.startedNano : 0n,
        tool: name,
        errorType: failed ? (error?.type ?? "tool_error") : undefined,
      })
    }

    // gen_ai.tool.message — one per tool result, anchored at the tool span
    options.emitLogEvent?.({
      event: "tool",
      sessionID: sid,
      timeMs: Number(endNano / 1_000_000n),
      traceId,
      spanId,
      callId,
      tool: name,
      content: options.gates.toolContent ? result : undefined,
      failed,
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
    activeChatContext(sessionID) {
      // steps is keyed by assistantMessageID; at most one step per session is in flight
      // (opencode serializes the step loop), so the first session match IS the active one
      for (const step of steps.values()) {
        if (step.sessionID !== sessionID) continue
        // An interrupted round's leftover step must not advertise coordinates: its chat
        // span id would be injected as a phantom traceparent under the next turn's trace
        if (step.interrupted) continue
        const traceId = isChild(sessionID) ? childTrace(sessionID).traceId : openTurns.get(sessionID)?.traceId
        if (!traceId) return undefined
        return {
          traceId,
          spanId: chatSpanId(step.assistantMessageID),
          agent: step.agent,
          model: step.model,
        }
      }
      return undefined
    },
    emit,
  }
}
