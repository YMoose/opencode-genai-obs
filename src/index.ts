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
import { createMetrics } from "./metrics.js"
import { createLogs } from "./logs.js"

const PIPELINE_KEY = "__ocgObsPipeline$"
const GENERATION_KEY = "__ocgObsPipelineGen$"

/** Shared pipeline: the owner creates and publishes it on globalThis; every instance's hook callbacks delegate here */
interface Pipeline {
  readonly generation: number
  readonly dispose: () => Promise<void>
  recordWsSend: (event: Record<string, unknown>) => void
  recordHttpRequest: (event: Record<string, unknown>) => void
  handlePrompt: (sessionID: string, messageID: string, text: string) => void
  /** Inject a W3C traceparent into the outgoing model request's headers (no-op unless the provider is whitelisted and a step is in flight) */
  injectTraceContext: (event: {
    sessionID: string
    agent: string
    model: { providerID: string; id: string }
    kind: string
    headers: Record<string, string>
  }) => void
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

/** Minimal shape of the plugin ctx (buildPipeline needs only these) */
interface PipelineCtx {
  session: {
    get: (input: { sessionID: string }) => Promise<{
      parentID?: string
      agent?: string
      title?: string
      location?: { directory?: string }
    }>
    /** Cursor-paginated list (SDK SessionsResponse: { data, cursor: { next?: string | null } }) */
    list: (input?: { cursor?: string; limit?: number }) => Promise<{
      data: ReadonlyArray<{
        id: string
        title?: string
        location?: { directory?: string }
      }>
      cursor: { next?: string | null }
    }>
  }
  event: {
    subscribe: () => AsyncIterable<unknown>
  }
}

/** Basename of the session directory = the project label (same convention as sync.py) */
function projectLabel(directory: string | undefined): string | undefined {
  return directory ? directory.replace(/\/+$/, "").split("/").pop() : undefined
}

/**
 * Delay between the first terminal execution event and the post-span annotation: the
 * annotation must land after the sender flushed the first spans (which create the
 * Phoenix ProjectSession row), otherwise the POST 404s.
 */
const POST_SPAN_ANNOTATE_DELAY_MS = 3_000

/** W3C traceparent: version 00, sampled flag 01 (we never sample) */
const formatTraceparent = (traceId: string, spanId: string): string => `00-${traceId}-${spanId}-01`

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
      injectTraceContext: () => {},
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
  const propagationProviders = new Set(config.tracing.propagation.providers)

  const metrics = config.metrics.enabled
    ? createMetrics({
        endpoint: config.metrics.endpoint ?? config.tracing.endpoint,
        headers: config.metrics.headers,
        resourceAttributes: config.tracing.resourceAttributes,
        intervalMs: config.metrics.intervalMs,
      })
    : undefined

  const logs = config.logs.enabled
    ? createLogs({
        endpoint: config.logs.endpoint ?? config.tracing.endpoint,
        headers: config.logs.headers,
        resourceAttributes: config.tracing.resourceAttributes,
        contentMaxLength: config.tracing.contentMaxLength,
        intervalMs: config.logs.intervalMs,
      })
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
      observe: metrics?.observe,
      emitLogEvent: logs?.emit,
    },
    (span) => sender.push(span),
    log,
  )

  /**
   * session.created / session.renamed → real-time project/title annotation
   * (optional enhancement, on by default: hits the Phoenix-compatible
   * /v1/session_annotations, not an OTLP standard; disable via tracing.annotations.enabled).
   * Sub-agent sessions are annotated as well: current Phoenix lists every session,
   * including sub-agents, so there is no record to miss.
   * directory comes from session.get (its basename is the project label, same as sync.py).
   */
  const annotateFromEvent = (sessionID: string, data: Record<string, unknown>) => {
    if (!annotator) return
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
      await annotator.annotate(sessionID, { title, projectLabel: projectLabel(directory) })
    })()
  }

  // The first terminal execution event of a session is the earliest moment its spans exist:
  // schedule one delayed annotation so the Phoenix ProjectSession row is created first
  let stopped = false
  const postSpanAnnotated = new Set<string>()
  const postSpanTimers = new Set<ReturnType<typeof setTimeout>>()
  const schedulePostSpanAnnotate = (sessionID: string): void => {
    if (!annotator || postSpanAnnotated.has(sessionID)) return
    postSpanAnnotated.add(sessionID)
    const timer = setTimeout(() => {
      postSpanTimers.delete(timer)
      if (stopped) return
      annotateFromEvent(sessionID, {})
    }, POST_SPAN_ANNOTATE_DELAY_MS)
    timer.unref()
    postSpanTimers.add(timer)
  }

  // SSE event pump (standalone background loop)
  const iter = ctx.event.subscribe()
  const eventIterator = iter[Symbol.asyncIterator]()
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
            if (
              (event.type === "session.execution.succeeded" ||
                event.type === "session.execution.failed" ||
                event.type === "session.execution.interrupted") &&
              typeof data.sessionID === "string"
            ) {
              schedulePostSpanAnnotate(data.sessionID)
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
    metrics: config.metrics.enabled ? { endpoint: config.metrics.endpoint ?? config.tracing.endpoint, intervalMs: config.metrics.intervalMs } : false,
    logs: config.logs.enabled ? { endpoint: config.logs.endpoint ?? config.tracing.endpoint } : false,
  })

  // Sessions created before this process loaded (e.g. opencode restarted mid-session) never
  // emit session.created here; the upsert semantics make rewriting them harmless
  if (annotator) {
    void (async () => {
      let cursor: string | undefined
      let attempted = 0
      try {
        while (!stopped) {
          const page = await ctx.session.list(cursor ? { cursor } : undefined)
          for (const session of page.data) {
            if (stopped) break
            await annotator.annotate(session.id, {
              title: session.title,
              projectLabel: projectLabel(session.location?.directory),
            })
            attempted += 1
          }
          const nextCursor = page.cursor?.next ?? undefined
          if (!nextCursor || nextCursor === cursor) break
          cursor = nextCursor
        }
        log("annotation backfill done", { attempted })
      } catch (error) {
        log("annotation backfill failed", { attempted, error: String(error) })
      }
    })()
  }

  return {
    generation: pipelineGlobal.nextGeneration(),
    async dispose() {
      stopped = true
      for (const timer of postSpanTimers) clearTimeout(timer)
      postSpanTimers.clear()
      await eventIterator.return?.()
      await spanBuilder.flushAll()
      await sender.drain()
      await sender.close()
      await metrics?.shutdown()
      await logs?.shutdown()
      await wire.dispose()
    },
    recordWsSend: (event) => wire.recordWsSend(event as unknown as Parameters<typeof wire.recordWsSend>[0]),
    recordHttpRequest: (event) => wire.recordHttpRequest(event as unknown as Parameters<typeof wire.recordHttpRequest>[0]),
    handlePrompt: (sessionID, messageID, text) => spanBuilder.handlePrompt(sessionID, messageID, text),
    injectTraceContext: (event) => {
      // Auxiliary requests (title/compaction/generate) share the session but not the
      // active step — injecting the step's context would mis-parent them
      if (event.kind !== "primary") return
      if (!propagationProviders.has("*") && !propagationProviders.has(event.model.providerID)) return
      const active = spanBuilder.activeChatContext(event.sessionID)
      if (!active) return
      // Only the request that IS the active step may carry its context: provider,
      // model and agent must match (concurrent background requests must not attach)
      if (active.agent !== event.agent || active.model.providerID !== event.model.providerID || active.model.id !== event.model.id) return
      event.headers.traceparent = formatTraceparent(active.traceId, active.spanId)
    },
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

      if (config.tracing.propagation.providers.length > 0) {
        const modelReqReg = await ctx.session.hook("model.request", (event) => {
          const req = event as unknown as {
            sessionID: string
            agent: string
            model: { providerID: string; id: string }
            kind: string
            headers: Record<string, string>
          }
          dispatch("model.request", (pipeline) => pipeline.injectTraceContext(req))
        })
        disposers.push(() => { modelReqReg.dispose() })
        log("trace propagation on", { providers: config.tracing.propagation.providers })
      }
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
