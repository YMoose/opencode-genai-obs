/**
 * 事件驱动 span builder（实时通道）—— adapter.py 投影逻辑的流式版。
 *
 * 状态机（详见 obsystem/otel-span-exportor/MERGED-PLUGIN.md §2）：
 * - prompt hook 暂存 {messageID, text}；首个 step.started 时开 turn（此时
 *   session.created 必然已过 SSE 泵，能判定 root/subagent）
 * - step.ended/failed → 立刻发 chat span（消费一帧 pending wire body 填 input.value）
 * - tool.input.started → 记 tool 名；tool.called → 记 input；success/failed → 立刻发 tool span
 * - text.ended → 累计该消息文本（chat span output.value + 轮根最后一答候选）
 * - execution.succeeded/failed/interrupted → 收尾：发轮根 span（root 会话）
 *   或 invoke_agent 容器 span（subagent 会话）
 * - subagent 挂接：父会话 tool.success 的 metadata.sessionID 注册挂接点；
 *   子会话一切 span 的 traceId 继承父轮、parentSpanId 链到容器 span
 *
 * 确定性 id（与 adapter.py 逐字节一致，Phase 3 重放靠它幂等去重）：
 *   traceId      = sha256("opencode-turn:{sid}:{userMessageID}")      取前 16 字节
 *   turnSpanId   = sha256("opencode-turn-span:{sid}:{userMessageID}") 取前 8 字节
 *   chatSpanId   = sha256("opencode-chat:{assistantMessageID}")       取前 8 字节
 *   toolSpanId   = sha256("opencode-tool:{assistantMessageID}:{toolCallID}") 取前 8 字节
 *   sessionSpanId= sha256("opencode-session:{childSessionID}")        取前 8 字节
 */

import { createHash } from "node:crypto"
import type { SpanRecord, AttrValue } from "./otlp.js"

const KIND_INTERNAL = 1
const KIND_CLIENT = 3

function hash(input: string, bytes: number): string {
  return createHash("sha256").update(input).digest("hex").slice(0, bytes * 2)
}

function nano(ms: number): bigint {
  return BigInt(Math.floor(ms)) * 1_000_000n
}

/**
 * 内容截断（对齐 CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH 语义）：
 * 超限截断到 limit 并追加标记；返回截断后值 + 原长（供 *_original_length 属性）。
 */
function truncate(value: string, limit: number): { value: string; originalLength?: number } {
  if (limit <= 0 || value.length <= limit) return { value }
  return { value: value.slice(0, limit) + `[TRUNCATED original_length=${value.length}]`, originalLength: value.length }
}

/** 跳过 null/undefined/空串，其余保留（对齐 adapter._attrs） */
function attrs(...pairs: ReadonlyArray<readonly [string, AttrValue | null | undefined]>): Array<readonly [string, AttrValue]> {
  const out: Array<readonly [string, AttrValue]> = []
  for (const [key, value] of pairs) {
    if (value !== null && value !== undefined && value !== "") out.push([key, value])
  }
  return out
}

function preview(text: string | null | undefined): string {
  const flat = (text ?? "").split(/\s+/).join(" ")
  if (!flat) return "(empty)"
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
// 事件数据的最小形状（只声明我们用到的字段，避免引 opencode 内部类型）
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
  readonly assistantMessageID: string
  name?: string
  input?: Record<string, unknown>
  readonly startedNano: bigint
}

export interface SpanBuilderOptions {
  /** 细粒度内容门（默认值见 config.ts；对齐 Claude Code OTEL_LOG_* 三门语义） */
  readonly gates: {
    readonly userPrompts: boolean
    readonly assistantResponses: boolean
    readonly toolDetails: boolean
    readonly toolContent: boolean
    readonly wireBody: boolean
  }
  /** 内容类属性最大长度（字符），0 = 不截断 */
  readonly contentMaxLength: number
  /** 取 pending wire body（kind=primary FIFO）；无则 undefined */
  readonly consumeWire: (sessionID: string) => { readonly frame: string; readonly seq: number } | undefined
  /** 异步取 session 最新 info（收尾轮根时补 title/directory）；失败返回 undefined */
  readonly getSessionInfo?: (sessionID: string) => Promise<SessionInfoLite | undefined>
}

export interface SpanBuilder {
  /** 处理一条 SSE 事件（session.* 命名空间） */
  readonly handleEvent: (event: EventBase) => void
  /** 处理 prompt hook（用户消息提交；仅暂存，不开 turn） */
  readonly handlePrompt: (sessionID: string, messageID: string, text: string) => void
  /** 收尾：把所有进行中的 turn/容器 flush（插件卸载时调用） */
  readonly flushAll: () => Promise<void>
  readonly emit: (span: SpanRecord) => void
}

export function createSpanBuilder(
  options: SpanBuilderOptions,
  emit: (span: SpanRecord) => void,
  log: (msg: string, data?: unknown) => void,
): SpanBuilder {
  /** 会话注册表：session.created 时填入（parentID → subagent） */
  const sessions = new Map<string, SessionInfoLite>()
  /** root 会话当前打开的 turn */
  const openTurns = new Map<string, TurnState>()
  /** prompt hook 暂存：等 step.started 时判定开 turn 还是忽略（subagent） */
  const pendingPrompts = new Map<string, { messageID: string; text: string }>()
  /** step 暂态：assistantMessageID → StepState */
  const steps = new Map<string, StepState>()
  /** tool 暂态：toolCallId → ToolState */
  const tools = new Map<string, ToolState>()
  /** subagent 挂接点：子 sessionID → { toolSpanId, traceId, parentSid } */
  const links = new Map<string, { toolSpanId: string; traceId: string; parentSid: string }>()
  /** subagent 会话已建容器 span 的开始时间（容器 span 收尾时才发） */
  const containers = new Map<string, { startedNano: bigint; lastEndNano: bigint }>()
  /** root 会话 turn 序号 */
  const turnCounters = new Map<string, number>()

  const isChild = (sid: string): boolean => {
    const link = links.get(sid)
    if (link) return true
    const info = sessions.get(sid)
    return info?.parentID !== undefined
  }

  /** 子会话的 trace 继承：link 已知用 link；否则找父会话当前 turn（兜底自己开独立 trace） */
  const childTrace = (sid: string): { traceId: string; containerId: string } => {
    const containerId = hash(`opencode-session:${sid}`, 8)
    const link = links.get(sid)
    if (link) return { traceId: link.traceId, containerId }
    const info = sessions.get(sid)
    const parentTurn = info?.parentID ? openTurns.get(info.parentID) : undefined
    if (parentTurn) return { traceId: parentTurn.traceId, containerId }
    // 兜底：父轮已结束且 link 未注册（异常时序），自己开 trace，容器当根
    return { traceId: hash(`opencode-turn:${sid}:orphan`, 16), containerId }
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

    // 收尾时补 title/directory（title 可能刚生成完）
    const info = options.getSessionInfo ? await options.getSessionInfo(sid) : undefined
    const merged: SessionInfoLite = { ...sessions.get(sid), ...info }

    const limit = options.contentMaxLength
    const inputTrunc = options.gates.userPrompts ? truncate(turn.inputText, limit) : undefined
    const outputTrunc = options.gates.assistantResponses && turn.lastAnswer ? truncate(turn.lastAnswer, limit) : undefined

    const span: SpanRecord = {
      traceId: turn.traceId,
      spanId: turn.spanId,
      name: preview(turn.inputText) || merged.title || turn.key,
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
      traceId: hash(`opencode-turn:${sid}:${messageID}`, 16),
      spanId: hash(`opencode-turn-span:${sid}:${messageID}`, 8),
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
        sessions.set(sid, {
          parentID: data.parentID as string | undefined,
          agent: data.agent as string | undefined,
        })
        if (links.has(sid)) ensureContainer(sid, nano(event.created))
        return
      }

      case "session.renamed": {
        const info = sessions.get(sid)
        if (info) info.title = data.title as string | undefined
        return
      }

      case "session.step.started": {
        // 首个 step 时按 prompt 暂存开 turn（此刻 session.created 已知，分类可靠）
        if (isChild(sid)) {
          pendingPrompts.delete(sid) // subagent 的 prompt 暂存不消费则丢弃
        } else {
          const pending = pendingPrompts.get(sid)
          if (pending) {
            pendingPrompts.delete(sid)
            const existing = openTurns.get(sid)
            if (existing && existing.key !== pending.messageID) {
              // 上一轮的执行流没等到 succeeded 就被新 prompt 顶掉：直接补发上轮轮根
              void flushTurnRoot(sid, nano(event.created))
            }
            openTurn(sid, pending.messageID, pending.text, event.created, data.agent as string | undefined)
          } else if (!openTurns.has(sid)) {
            // 无 prompt 暂存（合成请求/命令等）：以 event 伪造 turn key，保证有轮可挂
            openTurn(sid, `auto:${event.created}`, "(auto)", event.created, data.agent as string | undefined)
          }
        }
        const assistantMessageID = data.assistantMessageID as string
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
          // 轮根的最后一答候选
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

      case "session.step.ended":
      case "session.step.failed": {
        const assistantMessageID = data.assistantMessageID as string
        const step = steps.get(assistantMessageID)
        steps.delete(assistantMessageID)
        const endNano = nano(event.created)
        const error = event.type === "session.step.failed" ? (data.error as { type?: string; message?: string } | undefined) : undefined
        emitChatSpan(sid, assistantMessageID, step, data, endNano, error)
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
        const callId = data.id as string
        tools.set(callId, {
          callId,
          assistantMessageID: data.assistantMessageID as string,
          name: data.name as string,
          startedNano: nano(event.created),
        })
        return
      }

      case "session.tool.called": {
        const callId = data.id as string
        const existing = tools.get(callId)
        if (existing) {
          existing.input = data.input as Record<string, unknown>
        } else {
          tools.set(callId, {
            callId,
            assistantMessageID: data.assistantMessageID as string,
            input: data.input as Record<string, unknown>,
            startedNano: nano(event.created),
          })
        }
        return
      }

      case "session.tool.success":
      case "session.tool.failed": {
        const callId = data.id as string
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
    const child = isChild(sid)
    const traceId = child ? childTrace(sid).traceId : openTurns.get(sid)?.traceId
    const parentId = child ? childTrace(sid).containerId : openTurns.get(sid)?.spanId
    if (!traceId || !parentId) return // 无轮可挂（理论上 step 必然先 started，保险）

    const tokens = data.tokens as TokenUsage | undefined
    const cost = data.cost as number | undefined
    const finish = data.finish as string | undefined
    const model = step?.model ?? { id: "unknown", providerID: "" }
    const texts = step?.texts ?? []
    const reasoning = step?.reasoning ?? []
    const wire = options.consumeWire(sid)

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
      spanId: hash(`opencode-chat:${assistantMessageID}`, 8),
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
        // Phoenix / OpenInference mirrors
        ["openinference.span.kind", "LLM"],
        ["llm.model_name", model.id],
        ["llm.token_count.prompt", inputTokens],
        ["llm.token_count.completion", outputTokens],
        ["llm.token_count.total", tokens ? totalTokens(tokens) : undefined],
        ["llm.total_cost", cost],
        // wire body → input.value（OpenInference 原生，弃 gen_ai.request.raw）
        ["input.value", wireTrunc?.value],
        ["input.value_original_length", wireTrunc?.originalLength],
        ["input.mime_type", wireTrunc ? "application/json" : undefined],
        ["output.value", outputTrunc?.value],
        ["output.value_original_length", outputTrunc?.originalLength],
        ["opencode.message.id", assistantMessageID],
        ["opencode.agent", step?.agent],
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
    const assistantMessageID = tool?.assistantMessageID ?? (data.assistantMessageID as string)
    // tool span 父链 = 发起它的 chat span（确定性 id，chat span 先发后到无所谓）
    const parentId = hash(`opencode-chat:${assistantMessageID}`, 8)
    const name = tool?.name ?? "unknown"
    const input = tool?.input ?? {}
    const isSubagent = name === "subagent" || name === "task"
    const content = data.content as Array<{ type: string; text?: string }> | undefined
    const result = content?.length
      ? JSON.stringify(content.map((item) => (item.type === "text" ? item.text ?? "" : item)))
      : undefined
    const error = data.error as { type?: string; message?: string } | undefined

    const spanId = hash(`opencode-tool:${assistantMessageID}:${callId}`, 8)

    // subagent 挂接：metadata.sessionID → 建立挂接点
    if (isSubagent) {
      const metadata = data.metadata as Record<string, unknown> | undefined
      const childSid = metadata?.sessionID as string | undefined
      if (childSid) {
        links.set(childSid, { toolSpanId: spanId, traceId, parentSid: sid })
        ensureContainer(childSid, endNano)
        const info = sessions.get(childSid)
        if (!info?.parentID) sessions.set(childSid, { ...info, parentID: sid })
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

  /** subagent 会话收尾：发 invoke_agent 容器 span */
  const flushContainer = async (sid: string, endNano: bigint, error?: { type?: string; message?: string }) => {
    const container = containers.get(sid)
    if (!container) return // 没有任何 step/tool 产生过（空会话），不发
    containers.delete(sid)
    const link = links.get(sid)
    const traceId = link?.traceId ?? childTrace(sid).traceId
    const info = options.getSessionInfo ? await options.getSessionInfo(sid) : sessions.get(sid)

    emit({
      traceId,
      spanId: hash(`opencode-session:${sid}`, 8),
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
    },
    emit,
  }
}
