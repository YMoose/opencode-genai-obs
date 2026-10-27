/**
 * opencode-genai-tracing — 插件入口。
 *
 * Phase 1：wire body 采集（v2 session hook → JSONL 落盘 + pending 槽）
 * Phase 2：事件驱动 span builder（ctx.event.subscribe → OTLP span → Phoenix）
 *
 * 安装：~/.config/opencode/opencode.json 的 plugin 数组加本目录绝对路径
 * 配置：~/.config/opencode/ocg-tracing.json（可选，JSONC）
 *
 * 多实例架构（实测 3 个独立 module realm/进程）：
 * - session hook（ws.send / http.request / prompt）按 session 所在 location 的
 *   实例派发 —— 每个实例都注册 hook，回调统一委托 globalThis 上的共享 pipeline
 * - SSE 事件订阅每实例 1:1 活着 —— span pipeline 只允许 owner realm 建立
 *   （确定性 span id + Phoenix DO_NOTHING 下重复发不出错，但浪费且竞态 wire 帧）
 * - globalThis 是同进程多 module realm 间唯一的共享点
 */
import { Plugin } from "@opencode/plugin"
import { loadConfig, type Config } from "./config.js"
import { initLogger, log } from "./logger.js"
import { createWireRecorder } from "./wire.js"
import { createSender } from "./sender.js"
import { createSpanBuilder } from "./spans.js"
import { createAnnotator } from "./annotations.js"

const PIPELINE_KEY = "__ocgTracingPipeline$"

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
  const sender = createSender(
    {
      endpoint: config.tracing.endpoint,
      project: config.tracing.project,
      headers: config.tracing.headers,
      resourceAttributes: config.tracing.resourceAttributes,
    },
    log,
  )
  const annotator = createAnnotator({ endpoint: config.tracing.endpoint, headers: config.tracing.headers }, log)
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
    generation: ((pipelineGlobal.get()?.generation ?? 0) + 1),
    async dispose() {
      stopped = true
      await eventIterator.return?.()
      await spanBuilder.flushAll()
      await sender.drain()
      wire.dispose()
    },
    recordWsSend: (event) => wire.recordWsSend(event as unknown as Parameters<typeof wire.recordWsSend>[0]),
    recordHttpRequest: (event) => wire.recordHttpRequest(event as unknown as Parameters<typeof wire.recordHttpRequest>[0]),
    handlePrompt: (sessionID, messageID, text) => spanBuilder.handlePrompt(sessionID, messageID, text),
  }
}

export default Plugin.define({
  id: "opencode-genai-tracing",
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

    const disposers: Array<() => void | Promise<void>> = []

    // --- 每实例都注册 hook：按 location 派发，回调委托共享 pipeline ---
    if (config.wire.enabled || config.tracing.enabled) {
      const wsReg = await ctx.session.hook("experimental.ws.send", (event) => {
        pipelineGlobal.get()?.recordWsSend(event as unknown as Record<string, unknown>)
      })
      const httpReg = await ctx.session.hook("http.request", (event) => {
        pipelineGlobal.get()?.recordHttpRequest(event as unknown as Record<string, unknown>)
      })
      disposers.push(() => {
        wsReg.dispose()
        httpReg.dispose()
      })
    }
    if (config.tracing.enabled) {
      const promptReg = await ctx.session.hook("prompt", (event) => {
        const promptEvent = event as unknown as { sessionID: string; messageID: string; prompt: { text: string } }
        pipelineGlobal.get()?.handlePrompt(promptEvent.sessionID, promptEvent.messageID, promptEvent.prompt.text)
      })
      disposers.push(() => promptReg.dispose())
    }

    // --- owner 选举：第一个到达的实例建立并发布共享 pipeline ---
    if (pipelineGlobal.get() !== undefined) {
      log(`pipeline owned by another realm (gen ${pipelineGlobal.get()!.generation}); observer instance`)
    } else if (config.tracing.enabled || config.wire.enabled) {
      const owner = await buildPipeline(ctx, config)
      pipelineGlobal.set(owner)
      log("pipeline owner established", { generation: owner.generation })
      disposers.push(async () => {
        if (pipelineGlobal.get() === owner) pipelineGlobal.set(undefined)
        await owner.dispose()
      })
    }

    return async () => {
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
