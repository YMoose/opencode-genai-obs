/**
 * @fileoverview Batched OTLP span sender with retry/backoff, bounded queue, and
 * bounded drain-on-dispose (Bug 38). Shutdown separates spec-mandated bounds
 * (drainBudgetMs / closeBudgetMs, always enforced so unload never hangs the host)
 * from CLI fast-fail shortcuts (pre-drain TCP probe + lastExportFailed short-circuit,
 * enabled by default via fastShutdown for instant exit when no local collector runs).
 */

import { createTraceExporter, type SpanRecord } from "./otlp.js"
import { probeEndpoint } from "./probe.js"

export interface SenderOptions {
  readonly endpoint: string
  readonly project?: string
  /** Extra request headers (auth etc.) */
  readonly headers?: Record<string, string>
  /** Custom attributes merged into the OTLP resource block */
  readonly resourceAttributes?: Record<string, string>
  /** Max spans per batch (OTLP HTTP has no gRPC 4MB limit, but huge batches are expensive to retry) */
  readonly batchSize?: number
  /** Drop the oldest spans when the queue is full (memory guard against long backend outages) */
  readonly maxQueue?: number
  /** Base retry backoff in ms, default 1s */
  readonly retryDelayMs?: number
  /** Per-POST timeout in ms, default 30s */
  readonly timeoutMs?: number
  /** Total time drain() may spend at unload (waiting for an in-flight send + a final flush), default 1s */
  readonly drainBudgetMs?: number
  /** Time close() may spend releasing the exporter, default 0.5s */
  readonly closeBudgetMs?: number
  /**
   * Enable CLI fast-fail shortcuts at shutdown (150ms TCP pre-probe + skip retry when
   * the last export failed), default true. When false, drain() still enforces
   * drainBudgetMs/closeBudgetMs per OTel spec but always attempts the final flush.
   */
  readonly fastShutdown?: boolean
}

interface Item {
  readonly span: SpanRecord
  attempts: number
}

const MAX_ATTEMPTS = 5
const BASE_DELAY_MS = 1_000
// Shutdown bounds. With the collector stopped, every host exit or plugin reload otherwise waits out the exporter's
// own retries (about 3 s measured). Blast radius: spans still queued when a bound is hit are dropped and never
// retried at shutdown; with a healthy backend the final flush finishes well inside these limits.
const DRAIN_BUDGET_MS = 1_000
const CLOSE_BUDGET_MS = 500
// One TCP connect before the final flush: a refused connection answers in about 1 ms, so a dead endpoint costs no wait.
const PROBE_TIMEOUT_MS = 150

export interface Sender {
  readonly push: (span: SpanRecord) => void
  /** Wait for the queue to empty and stop the pump (called on plugin unload) */
  readonly drain: () => Promise<void>
  /** Release the exporter (after drain) */
  readonly close: () => Promise<void>
}

export function createSender(options: SenderOptions, log: (msg: string, data?: unknown) => void): Sender {
  const batchSize = options.batchSize ?? 32
  const maxQueue = options.maxQueue ?? 10_000
  const baseDelay = options.retryDelayMs ?? BASE_DELAY_MS
  const fastShutdown = options.fastShutdown ?? true
  const exporter = createTraceExporter(options)
  const queue: Item[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let pumping = false
  let disposed = false
  /** True after a failed send and until a send succeeds: the backend is presumed down, so shutdown does not retry */
  let lastExportFailed = false
  /** Set once shutdown concluded the backend is unreachable: close() then does not wait for the exporter */
  let backendDown = false

  const schedule = (delayMs: number) => {
    if (disposed || timer) return
    timer = setTimeout(() => {
      timer = undefined
      void pump()
    }, delayMs)
  }

  const pump = async () => {
    if (pumping || disposed || queue.length === 0) return
    pumping = true
    try {
      while (queue.length > 0 && !disposed) {
        const batch = queue.slice(0, batchSize)
        try {
          await exporter.exportBatch(batch.map((item) => item.span))
          lastExportFailed = false
          queue.splice(0, batch.length)
        } catch (error) {
          lastExportFailed = true
          for (const item of batch) item.attempts += 1
          const expired = batch.filter((item) => item.attempts >= MAX_ATTEMPTS)
          if (expired.length > 0) {
            queue.splice(0, expired.length)
            log("otlp send dropped spans after max attempts", {
              dropped: expired.length,
              lastError: String(error),
            })
          } else {
            // Safe: batch is non-empty (the loop only runs while queue.length > 0)
            const delay = baseDelay * 2 ** (batch[0]!.attempts - 1)
            schedule(delay)
            return
          }
        }
      }
    } finally {
      pumping = false
    }
  }

  return {
    push(span) {
      if (disposed) return
      if (queue.length >= maxQueue) {
        queue.shift()
        log("otlp queue full, dropped oldest span")
      }
      queue.push({ span, attempts: 0 })
      schedule(0)
    },
    async drain() {
      disposed = true
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      const deadline = Date.now() + (options.drainBudgetMs ?? DRAIN_BUDGET_MS)
      const dropAll = (reason: string) => {
        backendDown = true
        if (queue.length > 0) log(`otlp drain: ${reason}, dropping remaining`, { remaining: queue.length })
        queue.length = 0
      }
      // CLI fast-fail shortcut: one TCP connect before the final flush (skipped when fastShutdown is off —
      // a remote/proxied collector may refuse bare TCP connects yet still accept OTLP POSTs)
      if (fastShutdown && (pumping || queue.length > 0)) {
        const probe = await probeEndpoint(options.endpoint, PROBE_TIMEOUT_MS)
        if (!probe.ok) {
          dropAll(`endpoint not reachable (${probe.error ?? "no connection"})`)
          return
        }
      }
      /** Settles `{done:false}` at the shared deadline; the timer is unref'd so it cannot keep the host alive */
      const within = <T>(work: Promise<T>): Promise<{ done: true; value: T } | { done: false }> => {
        let timeout: ReturnType<typeof setTimeout> | undefined
        const expired = new Promise<{ done: false }>((resolve) => {
          timeout = setTimeout(() => resolve({ done: false }), Math.max(0, deadline - Date.now()))
          timeout.unref?.()
        })
        const finished = work.then((value) => ({ done: true as const, value }))
        return Promise.race([finished, expired]).finally(() => clearTimeout(timeout))
      }
      // Wait (bounded) for the in-flight pump before touching the queue concurrently
      if (pumping) {
        let abandon = false
        const idle = (async () => {
          while (pumping && !abandon) await new Promise<void>((resolve) => setTimeout(resolve, 25).unref?.())
        })()
        const settled = await within(idle)
        if (!settled.done) {
          abandon = true
          dropAll("in-flight send still pending at the drain budget")
          return
        }
      }
      // CLI fast-fail shortcut: a backend that just failed is presumed down, so do not spend the
      // shutdown budget retrying it (skipped when fastShutdown is off — the spec path always attempts the flush)
      if (fastShutdown && lastExportFailed) {
        dropAll("backend unreachable")
        return
      }
      while (queue.length > 0) {
        const batch = queue.splice(0, batchSize)
        const sent = exporter.exportBatch(batch.map((item) => item.span)).then(() => true, () => false)
        const result = await within(sent)
        if (!result.done || !result.value) {
          log("otlp drain flush failed, dropping remaining", { remaining: queue.length + batch.length })
          queue.length = 0
          break
        }
      }
    },
    async close() {
      // Fast-fail shortcut: do not wait for a backend we already know is gone (the exporter winds
      // down on its own). With fastShutdown off, the spec path keeps the bounded closeBudgetMs wait.
      if (fastShutdown && backendDown) {
        void exporter.close().catch(() => {})
        return
      }
      let timeout: ReturnType<typeof setTimeout> | undefined
      const budget = new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, options.closeBudgetMs ?? CLOSE_BUDGET_MS)
        timeout.unref?.()
      })
      try {
        await Promise.race([exporter.close().catch(() => {}), budget])
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}
