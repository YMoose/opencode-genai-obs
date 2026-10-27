/**
 * @fileoverview OTLP send queue: in-memory FIFO with exponential-backoff retry.
 * Spans buffer while the backend restarts; past the cap they are dropped with a
 * warn-log (tracing is the observability plane and never blocks the main path).
 */

import { postSpans, type SpanRecord } from "./otlp.js"

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
  /** Per-POST timeout in ms (passed through to postSpans), default 30s */
  readonly timeoutMs?: number
}

interface Item {
  readonly span: SpanRecord
  attempts: number
}

const MAX_ATTEMPTS = 5
const BASE_DELAY_MS = 1_000

export interface Sender {
  readonly push: (span: SpanRecord) => void
  /** Wait for the queue to empty and stop the pump (called on plugin unload) */
  readonly drain: () => Promise<void>
}

export function createSender(options: SenderOptions, log: (msg: string, data?: unknown) => void): Sender {
  const batchSize = options.batchSize ?? 32
  const maxQueue = options.maxQueue ?? 10_000
  const baseDelay = options.retryDelayMs ?? BASE_DELAY_MS
  const queue: Item[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let pumping = false
  let disposed = false

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
          await postSpans(batch.map((item) => item.span), options.endpoint, options)
          queue.splice(0, batch.length)
        } catch (error) {
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
      // Wait for the in-flight pump to finish before touching the queue concurrently
      while (pumping) await new Promise((resolve) => setTimeout(resolve, 25))
      while (queue.length > 0) {
        const batch = queue.splice(0, batchSize)
        try {
          await postSpans(batch.map((item) => item.span), options.endpoint, options)
        } catch {
          log("otlp drain flush failed, dropping remaining", { remaining: queue.length + batch.length })
          queue.length = 0
          break
        }
      }
    },
  }
}
