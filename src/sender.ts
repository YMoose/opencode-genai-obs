/**
 * OTLP 发送队列：内存 FIFO + 指数退避重试。
 * Phoenix 重启期间 span 攒着；超过上限后丢弃并 warn-log（tracing 是观测面，永不阻塞主路径）。
 */

import { postSpans, type SpanRecord } from "./otlp.js"

export interface SenderOptions {
  readonly endpoint: string
  readonly project?: string
  /** 额外请求头（认证等） */
  readonly headers?: Record<string, string>
  /** 并入 OTLP resource 块的自定义属性 */
  readonly resourceAttributes?: Record<string, string>
  /** 单批最大 span 数（OTLP HTTP 无 gRPC 4MB 限制，但批太大重试代价高） */
  readonly batchSize?: number
  /** 队列满时丢弃最老的 span（防 Phoenix 长期宕机撑爆内存） */
  readonly maxQueue?: number
  /** 重试基础退避毫秒数，默认 1s */
  readonly retryDelayMs?: number
  /** 单次 POST 超时毫秒数（透传给 postSpans），默认 30s */
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
  /** 等队列清空并停泵（插件卸载时调用） */
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
      // 等在途 pump 完成，避免并发冲同一队列
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
