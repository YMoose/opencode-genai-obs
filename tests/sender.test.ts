/**
 * sender.ts queue tests:
 * - Recovery after failed retries (exponential backoff with injectable short delays)
 * - drain() completes in bounded time under persistent backend failure (Bug 2 follow-up: timeouts guarantee unload never hangs)
 * - Queue full: drops the oldest span and logs it
 */
import test from "node:test"
import assert from "node:assert/strict"
import { createSender } from "../src/sender.js"
import type { SpanRecord } from "../src/otlp.js"
import { startServer, waitFor } from "./helpers.js"

let counter = 0
const makeSpan = (): SpanRecord => {
  counter += 1
  return {
    traceId: "a".repeat(32),
    spanId: String(counter).padStart(16, "0"),
    name: `span-${counter}`,
    kind: 3,
    startTimeUnixNano: 1n,
    endTimeUnixNano: 2n,
    attributes: [],
    status: { code: 1 },
  }
}

test("失败两次后重试成功，span 最终送达", async (t) => {
  const server = await startServer((_req, res, nth) => {
    if (nth < 2) {
      res.statusCode = 500
      res.end()
    } else {
      res.statusCode = 200
      res.end()
    }
  })
  t.after(() => server.close())

  const sender = createSender({ endpoint: server.url, retryDelayMs: 10, batchSize: 8, timeoutMs: 2_000 }, () => {})
  sender.push(makeSpan())
  await waitFor(() => server.requests.length >= 3, 5_000)
  await sender.drain()
  assert.ok(server.requests[2]!.body.includes("span-1"), "第三次请求应携带该 span")
})

test("对端持续失败：drain() 有界完成并丢弃剩余", async (t) => {
  const server = await startServer((_req, res) => {
    res.statusCode = 500
    res.end()
  })
  t.after(() => server.close())

  const logs: string[] = []
  const sender = createSender({ endpoint: server.url, retryDelayMs: 5, timeoutMs: 500 }, (msg) => logs.push(msg))
  sender.push(makeSpan())
  sender.push(makeSpan())
  await waitFor(() => server.requests.length >= 1, 5_000)
  // drain makes a single flush attempt and drops the rest on failure — it must never hang
  const start = Date.now()
  await sender.drain()
  assert.ok(Date.now() - start < 10_000, "drain 不应挂死")
  assert.ok(logs.some((line) => line.includes("dropping remaining")), "应记录丢弃")
})

test("队列满时丢弃最老 span 并留痕", async (t) => {
  // always 500 + long backoff: let the first batch fail and the queue back up
  const server = await startServer((_req, res) => {
    res.statusCode = 500
    res.end()
  })
  t.after(() => server.close())

  const logs: string[] = []
  const sender = createSender(
    { endpoint: server.url, retryDelayMs: 60_000, maxQueue: 2, timeoutMs: 500 },
    (msg) => logs.push(msg),
  )
  sender.push(makeSpan()) // joins the first batch; sending starts immediately
  sender.push(makeSpan())
  sender.push(makeSpan()) // queue hits the cap → oldest dropped
  await waitFor(() => server.requests.length >= 1, 5_000)
  assert.ok(logs.some((line) => line.includes("queue full") && line.includes("dropped oldest")), "应记录队列满丢弃")
  await sender.drain()
})
