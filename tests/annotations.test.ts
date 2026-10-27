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

test("404 两次后成功：annotation upsert 生效且 body 含 project+title", async (t) => {
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
  assert.strictEqual(server.requests.length, 3, "第 3 次应成功")
  assert.strictEqual(server.requests[0]!.path, "/v1/session_annotations?sync=true")
  const payload = JSON.parse(server.requests[2]!.body)
  assert.deepStrictEqual(
    payload.data.map((entry: { name: string }) => entry.name).sort(),
    ["project", "title"],
  )
  assert.ok(logs.some((line) => line.includes("session annotated")), "成功应留痕")
})

test("持续失败：重试 3 次后放弃（静默，不 throw）", async (t) => {
  const server = await startServer((_req, res) => {
    res.statusCode = 500
    res.end()
  })
  t.after(() => server.close())

  const logs: string[] = []
  const annotator = createAnnotator({ endpoint: server.url, retryDelayMs: 2, timeoutMs: 2_000 }, (msg) => logs.push(msg))
  await annotator.annotate("s1", { title: "T" }) // must not reject
  await waitFor(() => server.requests.length >= 3, 5_000)
  assert.ok(logs.some((line) => line.includes("gave up")), "放弃应留痕")
})

test("Bug 2：对端挂死时按超时中止重试，总耗时有界", async (t) => {
  const server = await startServer(() => {}) // never responds
  t.after(() => server.close())

  const logs: string[] = []
  const annotator = createAnnotator({ endpoint: server.url, retryDelayMs: 5, timeoutMs: 100 }, (msg) => logs.push(msg))
  const start = Date.now()
  await annotator.annotate("s1", { title: "T" })
  const elapsed = Date.now() - start
  assert.ok(elapsed < 3_000, `总耗时应远小于无超时场景（实际 ${elapsed}ms）`)
  assert.ok(logs.some((line) => line.includes("gave up")), "最终放弃并留痕")
})
