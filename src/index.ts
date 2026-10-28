/**
 * @fileoverview opencode-genai-obs — plugin entry.
 *
 * Wire body capture: v2 session hooks → JSONL + pending slots
 * Real-time tracing: event stream → OTLP spans → any OTLP/HTTP backend
 *
 * Install: add this directory's absolute path to the plugin array in
 * ~/.config/opencode/opencode.json
 * Config: ~/.config/opencode/ocg-obs.json (optional, JSONC)
 *
 * Multi-instance architecture (3 isolated module realms/processes observed):
 * - Session hooks (ws.send / http.request / prompt) dispatch to the instance owning the
 *   session's location — every instance registers hooks, and all callbacks delegate to
 *   a shared pipeline on globalThis
 * - SSE event subscriptions stay 1:1 per instance — only the owner realm builds the
 *   span pipeline (deterministic span ids + DO_NOTHING upserts on Phoenix-style backends
 *   make duplicates harmless, but they waste work and race wire frames)
 * - globalThis is the only shared point between module realms of one process
 * - Owner re-election: if a hot reload unloads the old owner while other instances
 *   live, their hook callbacks notice the missing pipeline and re-elect using their
 *   own ctx (dispatch → elect), so capture never fails silently
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

/** Shared pipeline: the owner creates and publishes it on globalThis; every instance's hook callbacks delegate here */
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
  /** Process-wide generation counter (outlives the pipeline object; keeps incrementing across owner changes) */
  nextGeneration(): number {
    const holder = globalThis as { [GENERATION_KEY]?: number }
    const next = (holder[GENERATION_KEY] ?? 0) + 1
    holder[GENERATION_KEY] = next
    return next
  },
}

/** Minimal shape of the plugin ctx (buildPipeline needs only these two) */
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

  // Wire-only mode (tracing.enabled=false): JSONL only — no spans/annotations/SSE pump,
  // guaranteeing nothing ever leaves this process
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
  const annotator = config.tracing.annotations.enabled
    ? createAnnotator({ endpoint: config.tracing.endpoint, headers: config.tracing.headers }, log)
    : undefined
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
   * session.created / session.renamed → real-time project/title annotation
   * (optional enhancement, on by default: hits the Phoenix-compatible
   * /v1/session_annotations, not an OTLP standard; disable via tracing.annotations.enabled).
   * Sub-agent sessions (parentID set) are skipped: Phoenix-style backends create
   * ProjectSessions for root sessions only, and annotating children 404s.
   * directory comes from session.get (its basename is the project label, same as sync.py).
   */
  const annotateFromEvent = (sessionID: string, data: Record<string, unknown>) => {
    if (!annotator) return
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

  // SSE event pump (standalone background loop)
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
  log("tracing on", {
    endpoint: config.tracing.endpoint,
    project: config.tracing.project,
    content: config.tracing.content,
    annotations: config.tracing.annotations.enabled,
  })

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
     * Elect/re-elect the owner. Reached from the first setup and from hook callbacks
     * that find the pipeline missing (previous owner unloaded); under concurrent
     * elections whoever publishes first wins and latecomers discard their own pipeline.
     */
    const elect = async (reason: string): Promise<void> => {
      if (unloading || owned || pipelineGlobal.get() || !pipelineCapable) return
      const candidate = await buildPipeline(ctx, config)
      if (unloading || pipelineGlobal.get()) {
        await candidate.dispose() // concurrent election/unload started: discard ours to avoid dual pipelines
        return
      }
      pipelineGlobal.set(candidate)
      owned = candidate
      log("pipeline owner established", { generation: candidate.generation, reason })
    }

    /** Unified hook-callback entry: deliver when the pipeline exists; otherwise re-elect and redeliver this event once done */
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
        .catch((error) => { log("pipeline re-elect failed", { error: String(error) }) })
    }

    // --- Every instance registers hooks: dispatched per location, delegating to the shared pipeline ---
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
      disposers.push(() => { promptReg.dispose() })
    }

    // --- First election: the first instance to arrive builds and publishes the shared pipeline ---
    const existing = pipelineGlobal.get()
    if (existing !== undefined) {
      log(`pipeline owned by another realm (gen ${existing.generation}); observer instance`)
    } else {
      await elect("setup")
    }

    // If this instance owns the pipeline it must reclaim it on unload
    // (registered last → runs first, before hook deregistration)
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
