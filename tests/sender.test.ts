/**
 * sender.ts queue tests:
 * - Recovery after failed retries (exponential backoff with injectable short delays)
 * - drain() completes in bounded time under persistent backend failure (Bug 2 follow-up: timeouts guarantee unload never hangs)
 * - Queue full: drops the oldest span and logs it
 * - Bug 38: spec-mandated shutdown bounds (drain/close budgets, always on) vs. CLI
 *   fast-fail shortcuts (pre-drain probe + lastExportFailed skip, fastShutdown-gated)
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

test("succeeds after two failures; the span is eventually delivered", async (t) => {
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
  await sender.close()
  assert.ok(server.requests[2]!.body.includes("span-1"), "the third request must carry that span")
})

test("persistent peer failure: drain() finishes in bounded time and drops the rest", async (t) => {
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
  await sender.close()
  assert.ok(Date.now() - start < 10_000, "drain must not hang")
  assert.ok(logs.some((line) => line.includes("dropping remaining")), "the drop must be logged")
})

test("queue full drops the oldest span and logs it", async (t) => {
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
  assert.ok(logs.some((line) => line.includes("queue full") && line.includes("dropped oldest")), "the queue-full drop must be logged")
  await sender.drain()
  await sender.close()
})

test("Bug 38: drain() returns within its budget while an in-flight send hangs", async (t) => {
  const server = await startServer(() => {
    /* never respond: the send stays in flight */
  })
  t.after(() => server.close())
  const logs: string[] = []
  const options = { endpoint: server.url, retryDelayMs: 10, timeoutMs: 5_000, drainBudgetMs: 200 }
  const sender = createSender(options, (m) => logs.push(m))
  sender.push(makeSpan())
  await waitFor(() => server.requests.length >= 1, 5_000)
  const started = Date.now()
  await sender.drain()
  assert.ok(Date.now() - started < 1_500, `drain must return within its budget, took ${Date.now() - started}ms`)
  assert.ok(logs.some((m) => m.includes("drain budget")), "the dropped spans are logged")
})

test("Bug 38: drain() sends nothing more once the last send failed (backend presumed down)", async (t) => {
  const server = await startServer((_req, res) => {
    res.statusCode = 400 // not retryable: fails fast, no exporter-internal retry
    res.end()
  })
  t.after(() => server.close())
  const sender = createSender({ endpoint: server.url, retryDelayMs: 60_000, timeoutMs: 2_000 }, () => {})
  sender.push(makeSpan())
  await waitFor(() => server.requests.length >= 1, 5_000)
  await new Promise((resolve) => setTimeout(resolve, 100)) // let the failed pump settle
  const before = server.requests.length
  await sender.drain()
  assert.equal(server.requests.length, before, "no extra request at shutdown while the backend is presumed down")
})

test("Bug 38 guard: drain() still delivers pending spans when the backend is healthy", async (t) => {
  const server = await startServer((_req, res) => {
    res.statusCode = 200
    res.end()
  })
  t.after(() => server.close())
  const sender = createSender({ endpoint: server.url, retryDelayMs: 10, timeoutMs: 2_000 }, () => {})
  const span = makeSpan()
  sender.push(span)
  await sender.drain()
  await sender.close()
  assert.ok(server.requests.some((r) => r.body.includes(span.name)), "the span reaches the backend on a healthy drain")
})

test("Bug 38: close() returns within its budget while an export hangs", async (t) => {
  const server = await startServer(() => {
    /* hang */
  })
  t.after(() => server.close())
  const options = { endpoint: server.url, timeoutMs: 5_000, closeBudgetMs: 200, drainBudgetMs: 50 }
  const sender = createSender(options, () => {})
  sender.push(makeSpan())
  await waitFor(() => server.requests.length >= 1, 5_000)
  const started = Date.now()
  await sender.close()
  assert.ok(Date.now() - started < 1_500, `close must return within its budget, took ${Date.now() - started}ms`)
})

test("Bug 38: drain() and close() return at once when nothing listens on the endpoint", async () => {
  const closed = await startServer(() => {})
  const deadUrl = closed.url
  await closed.close() // the port is now closed: connections are refused
  const logs: string[] = []
  const sender = createSender({ endpoint: deadUrl, retryDelayMs: 60_000, timeoutMs: 30_000 }, (m) => logs.push(m))
  sender.push(makeSpan())
  sender.push(makeSpan())
  const started = Date.now()
  await sender.drain()
  await sender.close()
  const took = Date.now() - started
  assert.ok(took < 600, `shutdown against a dead endpoint must be near-instant, took ${took}ms`)
  assert.ok(logs.some((m) => m.includes("endpoint not reachable")), "the drop is logged with its reason")
})

test("Bug 38 fastShutdown=false: drain() retries the final flush after a failed send and delivers the span", async (t) => {
  // First POST fails (400, non-retriable: fails fast, no exporter-internal retry — same trick as
  // the fastShutdown=true test above), the next one succeeds. fastShutdown=false must not treat
  // the failed send as "backend down" — it attempts the final flush within the budget.
  const server = await startServer((_req, res, nth) => {
    res.statusCode = nth === 0 ? 400 : 200
    res.end()
  })
  t.after(() => server.close())
  const sender = createSender(
    { endpoint: server.url, retryDelayMs: 60_000, timeoutMs: 2_000, fastShutdown: false, drainBudgetMs: 2_000 },
    () => {},
  )
  const span = makeSpan()
  sender.push(span)
  await waitFor(() => server.requests.length >= 1, 5_000)
  await new Promise((resolve) => setTimeout(resolve, 100)) // let the failed pump settle
  const before = server.requests.length
  const started = Date.now()
  await sender.drain()
  await sender.close()
  // The failed span was re-sent by the drain flush itself (not by the pump: retryDelayMs is 60 s)
  assert.ok(server.requests.length > before, "drain must attempt the final flush even after a failed export")
  assert.ok(server.requests.some((r) => r.body.includes(span.name)), "the queued span is delivered on the strict path")
  assert.ok(Date.now() - started < 4_000, "the strict path stays bounded by drainBudgetMs (+ close budget)")
})

test("Bug 38 fastShutdown=false: a hung endpoint is still bounded by drainBudgetMs", async (t) => {
  const server = await startServer(() => {
    /* never respond */
  })
  t.after(() => server.close())
  const sender = createSender(
    { endpoint: server.url, retryDelayMs: 10, timeoutMs: 5_000, fastShutdown: false, drainBudgetMs: 200 },
    () => {},
  )
  sender.push(makeSpan())
  await waitFor(() => server.requests.length >= 1, 5_000)
  const started = Date.now()
  await sender.drain()
  assert.ok(Date.now() - started < 1_500, `strict drain must stay bounded, took ${Date.now() - started}ms`)
  await sender.close()
})
