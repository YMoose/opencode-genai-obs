/**
 * 测试工具：本地假 OTLP 后端服务器、可控 SSE 事件流、mock 插件 ctx、env 快照。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface CapturedRequest {
  readonly method: string
  readonly path: string
  readonly headers: IncomingMessage["headers"]
  readonly body: string
}

export interface TestServer {
  readonly url: string
  readonly requests: CapturedRequest[]
  readonly close: () => Promise<void>
}

/** 起一个记录所有请求的本地 HTTP 服务器；handle 决定响应行为（可按第 n 次请求分支） */
export async function startServer(
  handle: (req: CapturedRequest, res: ServerResponse, nth: number) => void,
): Promise<TestServer> {
  const requests: CapturedRequest[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(chunk as Buffer))
    req.on("end", () => {
      const nth = requests.length
      const captured: CapturedRequest = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf-8"),
      }
      requests.push(captured)
      handle(captured, res, nth)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/** 轮询等待条件成立（默认 5s 超时） */
export async function waitFor(predicate: () => boolean, timeoutMs = 5_000, stepMs = 10): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout")
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

export interface Pushable {
  readonly iterable: AsyncIterable<unknown>
  push(event: unknown): void
}

/** 可手动推送的异步事件流（mock ctx.event.subscribe 的返回值） */
export function pushable(): Pushable {
  const queue: Array<IteratorResult<unknown>> = []
  const waiters: Array<(result: IteratorResult<unknown>) => void> = []
  const next = (): Promise<IteratorResult<unknown>> =>
    new Promise((resolve) => {
      if (queue.length) resolve(queue.shift()!)
      else waiters.push(resolve)
    })
  return {
    iterable: {
      [Symbol.asyncIterator]: () => ({
        next,
        return: async () => ({ value: undefined, done: true }) as IteratorResult<unknown>,
      }),
    },
    push(event: unknown): void {
      const result = { value: event, done: false }
      const waiter = waiters.shift()
      if (waiter) waiter(result)
      else queue.push(result)
    },
  }
}

export interface MockCtx {
  readonly ctx: unknown
  /** 每个 subscribe() 调用产生一个 Pushable（按创建序） */
  readonly feeds: Pushable[]
  fire(hookName: string, event: unknown): void
  has(hookName: string): boolean
}

/** mock 插件 ctx：记录 hook 回调供测试手动触发，session.get 返回固定根会话信息 */
export function makeCtx(overrides?: {
  sessionGet?: (input: { sessionID: string }) => Promise<Record<string, unknown>>
}): MockCtx {
  const hooks = new Map<string, (event: unknown) => void>()
  const feeds: Pushable[] = []
  const ctx = {
    session: {
      hook: async (name: string, callback: (event: unknown) => void) => {
        hooks.set(name, callback)
        return { dispose: () => hooks.delete(name) }
      },
      get:
        overrides?.sessionGet ??
        (async () => ({
          parentID: undefined,
          agent: "build",
          title: "test-title",
          location: { directory: "/home/u/proj" },
        })),
    },
    event: {
      subscribe: () => {
        const feed = pushable()
        feeds.push(feed)
        return feed.iterable
      },
    },
  }
  return {
    ctx,
    feeds,
    fire: (name, event) => hooks.get(name)?.(event),
    has: (name) => hooks.has(name),
  }
}

/** 会影响 loadConfig 的全部环境变量 */
export const CONFIG_ENV_KEYS = [
  "OCG_OBS_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OPENCODE_LOG_DIR",
] as const

export type EnvSnapshot = Partial<Record<(typeof CONFIG_ENV_KEYS)[number], string | undefined>>

export function snapshotEnv(): EnvSnapshot {
  const snapshot: EnvSnapshot = {}
  for (const key of CONFIG_ENV_KEYS) snapshot[key] = process.env[key]
  return snapshot
}

export function restoreEnv(snapshot: EnvSnapshot): void {
  for (const key of CONFIG_ENV_KEYS) {
    const value = snapshot[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}
