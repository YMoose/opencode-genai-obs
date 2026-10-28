/**
 * annotations.ts tests:
 * - Retry succeeds after 404s (Phoenix ingests spans asynchronously; 404 before the
 *   session exists is a known boundary)
 * - Persistent failure: gives up after 3 retries (offline sync.py is the backstop)
 * - Bug 2: a hung peer aborts per-request by timeout; total time stays bounded
 */
import test from "node:test"
import assert from "node:assert/strict"
import { createAnnotator } from "../src/annotations.js"
import { startServer, waitFor } from "./helpers.js"

test("succeeds after two 404s: annotation upsert takes effect and the body carries project+title", async (t) => {
  const server = await startServer((_req, res, nth) => {
    if (nth < 2) {
      res.statusCode = 404
      res.end("not found")
    } else {
      res.statusCode = 200
      res.end()
    }
  })
  t.after(() => server.close())

  const logs: string[] = []
  const annotator = createAnnotator({ endpoint: server.url, retryDelayMs: 5, timeoutMs: 2_000 }, (msg) => logs.push(msg))
  await annotator.annotate("s1", { title: "  T  ", projectLabel: "proj" })
  assert.strictEqual(server.requests.length, 3, "the 3rd attempt must succeed")
  assert.strictEqual(server.requests[0]!.path, "/v1/session_annotations?sync=true")
  const payload = JSON.parse(server.requests[2]!.body)
  assert.deepStrictEqual(
    payload.data.map((entry: { name: string }) => entry.name).sort(),
    ["project", "title"],
  )
  assert.ok(logs.some((line) => line.includes("session annotated")), "success must be logged")
})

test("persistent failure: gives up after 3 retries (silently, no throw)", async (t) => {
  const server = await startServer((_req, res) => {
    res.statusCode = 500
    res.end()
  })
  t.after(() => server.close())

  const logs: string[] = []
  const annotator = createAnnotator({ endpoint: server.url, retryDelayMs: 2, timeoutMs: 2_000 }, (msg) => logs.push(msg))
  await annotator.annotate("s1", { title: "T" }) // must not reject
  await waitFor(() => server.requests.length >= 3, 5_000)
  assert.ok(logs.some((line) => line.includes("gave up")), "giving up must be logged")
})

test("Bug 2: a hung peer aborts retries by timeout; total time stays bounded", async (t) => {
  const server = await startServer(() => {}) // never responds
  t.after(() => server.close())

  const logs: string[] = []
  const annotator = createAnnotator({ endpoint: server.url, retryDelayMs: 5, timeoutMs: 100 }, (msg) => logs.push(msg))
  const start = Date.now()
  await annotator.annotate("s1", { title: "T" })
  const elapsed = Date.now() - start
  assert.ok(elapsed < 3_000, `total time must be far below the no-timeout case (actual: ${elapsed}ms)`)
  assert.ok(logs.some((line) => line.includes("gave up")), "eventually gives up and logs it")
})
