/**
 * opencode-genai-obs — 插件入口。
 *
 * Phase 1：wire body 采集（v2 session hook → JSONL 落盘 + pending 槽）
 * Phase 2：事件驱动 span builder（ctx.event.subscribe → OTLP span → Phoenix）
 *
 * 安装：~/.config/opencode/opencode.json 的 plugin 数组加本目录绝对路径
 * 配置：~/.config/opencode/ocg-obs.json（可选，JSONC）
 *
 * 多实例架构（实测 3 个独立 module realm/进程）：
 * - session hook（ws.send / http.request / prompt）按 session 所在 location 的
 *   实例派发 —— 每个实例都注册 hook，回调统一委托 globalThis 上的共享 pipeline
 * - SSE 事件订阅每实例 1:1 活着 —— span pipeline 只允许 owner realm 建立
 *   （确定性 span id + Phoenix DO_NOTHING 下重复发不出错，但浪费且竞态 wire 帧）
 * - globalThis 是同进程多 module realm 间唯一的共享点
 * - owner 掉线补选：若热重载先载新实例再卸旧 owner，存活实例的 hook 回调发现
 *   pipeline 缺失时用自身 ctx 触发补选（dispatch → elect），采集不静默失效
 */
import { Plugin } from "@opencode/plugin"
import { loadConfig, type Config } from "./config.js"
import { initLogger, log } from "./logger.js"
import { createWireRecorder } from "./wire.js"
import { createSender } from "./sender.js"
import { createSpanBuilder } from "./spans.js"
import { createAnnotator } from "./annotations.js"

const PIPELINE_KEY = "__ocgObsPipeline$"
const GENERATION_KEY = "__ocgObsPipelineGen$"

/** 共享 pipeline：owner 创建并发布到 globalThis；所有实例的 hook 回调委托到这里 */
interface Pipeline {
  readonly generation: number
  readonly dispose: () => Promise<void>
  recordWsSend: (event: Record<string, unknown>) => void
  recordHttpRequest: (event: Record<string, unknown>) => void
  handlePrompt: (sessionID: string, messageID: string, text: string) => void
}

const pipelineGlobal = {
  get(): Pipeline | undefined {
    return (globalThis as { [PIPELINE_KEY]?: Pipeline })[PIPELINE_KEY]
  },
  set(pipeline: Pipeline | undefined): void {
    ;(globalThis as { [PIPELINE_KEY]?: Pipeline })[PIPELINE_KEY] = pipeline
  },
  /** 进程级代数计数（独立于 pipeline 对象存活，owner 更替后仍递增） */
  nextGeneration(): number {
    const holder = globalThis as { [GENERATION_KEY]?: number }
    const next = (holder[GENERATION_KEY] ?? 0) + 1
    holder[GENERATION_KEY] = next
    return next
  },
}

/** 插件 ctx 的最小形状（buildPipeline 只需要这两个） */
interface PipelineCtx {
  session: {
    get: (input: { sessionID: string }) => Promise<{
      parentID?: string
      agent?: string
      title?: string
      location?: { directory?: string }
    }>
  }
  event: {
    subscribe: () => AsyncIterable<unknown>
  }
}

async function buildPipeline(ctx: PipelineCtx, config: Config): Promise<Pipeline> {
  const wire = createWireRecorder(config.wire, log)

  // wire-only 模式（tracing.enabled=false）：只落 JSONL，不建 span/annotation/SSE 泵，
  // 保证任何数据都不离开本进程
  if (!config.tracing.enabled) {
    log("wire-only mode; tracing disabled, nothing leaves the process")
    return {
      generation: pipelineGlobal.nextGeneration(),
      async dispose() {
        await wire.dispose()
      },
      recordWsSend: (event) => wire.recordWsSend(event as unknown as Parameters<typeof wire.recordWsSend>[0]),
      recordHttpRequest: (event) => wire.recordHttpRequest(event as unknown as Parameters<typeof wire.recordHttpRequest>[0]),
      handlePrompt: () => {},
    }
  }

  const sender = createSender(
    {
      endpoint: config.tracing.endpoint,
      project: config.tracing.project,
      headers: config.tracing.headers,
      resourceAttributes: config.tracing.resourceAttributes,
    },
    log,
  )
  const annotator = createAnnotator(
    { endpoint: config.tracing.endpoint, headers: config.tracing.headers },
    log,
  )
  const spanBuilder = createSpanBuilder(
    {
      gates: config.tracing.contentGates,
      contentMaxLength: config.tracing.contentMaxLength,
      consumeWire: (sessionID) => wire.consumePending(sessionID),
      getSessionInfo: async (sessionID) => {
        try {
          const info = await ctx.session.get({ sessionID })
          return {
            parentID: info.parentID,
            agent: info.agent,
            title: info.title,
            directory: info.location?.directory,
          }
        } catch (error) {
          log("session.get failed", { sessionID, error: String(error) })
          return undefined
        }
      },
    },
    (span) => sender.push(span),
    log,
  )

  /**
   * session.created / session.renamed → 实时打 project/title annotation。
   * subagent 会话（有 parentID）跳过：Phoenix 只给根会话建 ProjectSession，打了 404。
   * directory 经 session.get 取（basename 即 project label，sync.py 同款）。
   */
  const annotateFromEvent = (sessionID: string, data: Record<string, unknown>) => {
    if (data.parentID) return
    void (async () => {
      let title = typeof data.title === "string" ? data.title : undefined
      let directory: string | undefined
      try {
        const info = await ctx.session.get({ sessionID })
        title = title ?? info.title
        directory = info.location?.directory
      } catch (error) {
        log("session.get failed (annotate)", { sessionID, error: String(error) })
      }
      const base = directory ? directory.replace(/\/+$/, "").split("/").pop() : undefined
      await annotator.annotate(sessionID, { title, projectLabel: base })
    })()
  }

  // SSE 事件泵（独立后台循环）
  const iter = ctx.event.subscribe()
  const eventIterator = iter[Symbol.asyncIterator]()
  let stopped = false
  void (async () => {
    try {
      while (!stopped) {
        const next = await eventIterator.next()
        if (next.done) break
        const event = next.value as { type?: string; created?: number; data?: Record<string, unknown> }
        try {
          if (typeof event.type === "string" && event.type.startsWith("session.")) {
            const data = event.data ?? {}
            spanBuilder.handleEvent({
              type: event.type,
              created: event.created ?? Date.now(),
              data,
            })
            if (
              (event.type === "session.created" || event.type === "session.renamed") &&
              typeof data.sessionID === "string"
            ) {
              annotateFromEvent(data.sessionID, data)
            }
          }
        } catch (error) {
          log("span builder event error", { type: event.type, error: String(error) })
        }
      }
    } catch (error) {
      log("event stream ended", { error: String(error) })
    }
  })()

  if (config.wire.enabled) log("wire capture on", { directory: config.wire.directory })
  log("tracing on", { endpoint: config.tracing.endpoint, project: config.tracing.project, content: config.tracing.content })

  return {
    generation: pipelineGlobal.nextGeneration(),
    async dispose() {
      stopped = true
      await eventIterator.return?.()
      await spanBuilder.flushAll()
      await sender.drain()
      await wire.dispose()
    },
    recordWsSend: (event) => wire.recordWsSend(event as unknown as Parameters<typeof wire.recordWsSend>[0]),
    recordHttpRequest: (event) => wire.recordHttpRequest(event as unknown as Parameters<typeof wire.recordHttpRequest>[0]),
    handlePrompt: (sessionID, messageID, text) => spanBuilder.handlePrompt(sessionID, messageID, text),
  }
}

export default Plugin.define({
  id: "opencode-genai-obs",
  setup: async (ctx) => {
    initLogger()

    const { config, warnings } = loadConfig(log)
    for (const warning of warnings) {
      log(`config warning [${warning.kind}]: ${warning.message}`)
    }

    if (!config.enabled) {
      log("disabled by config")
      return
    }

    const pipelineCapable = config.wire.enabled || config.tracing.enabled
    let unloading = false
    let owned: Pipeline | undefined
    const disposers: Array<() => void | Promise<void>> = []

    /**
     * 选举/补选 owner。首次 setup 与 hook 回调发现 pipeline 缺失（旧 owner 已卸载）时都会走到；
     * 并发补选时先发布者获胜，后来者丢弃自己的 pipeline。
     */
    const elect = async (reason: string): Promise<void> => {
      if (unloading || owned || pipelineGlobal.get() || !pipelineCapable) return
      const candidate = await buildPipeline(ctx, config)
      if (unloading || pipelineGlobal.get()) {
        await candidate.dispose() // 并发补选/已开始卸载：丢弃自己的，避免双 pipeline
        return
      }
      pipelineGlobal.set(candidate)
      owned = candidate
      log("pipeline owner established", { generation: candidate.generation, reason })
    }

    /** hook 回调统一入口：pipeline 在则投递；不在则触发补选并在完成后补投递本条事件 */
    const dispatch = (hook: string, deliver: (pipeline: Pipeline) => void): void => {
      const pipeline = pipelineGlobal.get()
      if (pipeline) {
        deliver(pipeline)
        return
      }
      if (unloading) return
      log("pipeline missing, re-electing", { hook })
      void elect(`hook:${hook}`)
        .then(() => {
          const revived = pipelineGlobal.get()
          if (revived && !unloading) deliver(revived)
        })
        .catch((error) => log("pipeline re-elect failed", { error: String(error) }))
    }

    // --- 每实例都注册 hook：按 location 派发，回调委托共享 pipeline ---
    if (pipelineCapable) {
      const wsReg = await ctx.session.hook("experimental.ws.send", (event) => {
        dispatch("ws.send", (pipeline) => pipeline.recordWsSend(event as unknown as Record<string, unknown>))
      })
      const httpReg = await ctx.session.hook("http.request", (event) => {
        dispatch("http.request", (pipeline) => pipeline.recordHttpRequest(event as unknown as Record<string, unknown>))
      })
      disposers.push(() => {
        wsReg.dispose()
        httpReg.dispose()
      })
    }
    if (config.tracing.enabled) {
      const promptReg = await ctx.session.hook("prompt", (event) => {
        const promptEvent = event as unknown as { sessionID: string; messageID: string; prompt: { text: string } }
        dispatch("prompt", (pipeline) => pipeline.handlePrompt(promptEvent.sessionID, promptEvent.messageID, promptEvent.prompt.text))
      })
      disposers.push(() => promptReg.dispose())
    }

    // --- 首次选举：第一个到达的实例建立并发布共享 pipeline ---
    if (pipelineGlobal.get() !== undefined) {
      log(`pipeline owned by another realm (gen ${pipelineGlobal.get()!.generation}); observer instance`)
    } else {
      await elect("setup")
    }

    // 本实例若持有 pipeline，卸载时负责回收（最后注册 → 最先执行，先于 hook 注销）
    disposers.push(async () => {
      unloading = true
      if (!owned) return
      if (pipelineGlobal.get() === owned) pipelineGlobal.set(undefined)
      await owned.dispose()
      owned = undefined
    })

    let unloaded = false
    return async () => {
      if (unloaded) return
      unloaded = true
      for (const dispose of disposers.reverse()) {
        try {
          await dispose()
        } catch (error) {
          log("dispose error", { error: String(error) })
        }
      }
      log("unloaded")
    }
  },
})
