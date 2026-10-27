/**
 * annotations.ts 测试：
 * - 404 后重试成功（Phoenix span 入库异步，session 未建出 404 的既定边界）
 * - 持续失败重试 3 次后放弃（离线 sync.py 兜底）
 * - Bug 2：对端挂死时单次请求按超时中止，总耗时上界可控
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
  await annotator.annotate("s1", { title: "T" }) // 不应 reject
  await waitFor(() => server.requests.length >= 3, 5_000)
  assert.ok(logs.some((line) => line.includes("gave up")), "放弃应留痕")
})

test("Bug 2：对端挂死时按超时中止重试，总耗时有界", async (t) => {
  const server = await startServer(() => {}) // 永不响应
  t.after(() => server.close())

  const logs: string[] = []
  const annotator = createAnnotator({ endpoint: server.url, retryDelayMs: 5, timeoutMs: 100 }, (msg) => logs.push(msg))
  const start = Date.now()
  await annotator.annotate("s1", { title: "T" })
  const elapsed = Date.now() - start
  assert.ok(elapsed < 3_000, `总耗时应远小于无超时场景（实际 ${elapsed}ms）`)
  assert.ok(logs.some((line) => line.includes("gave up")), "最终放弃并留痕")
})
