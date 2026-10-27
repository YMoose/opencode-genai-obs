/**
 * otlp.ts 编码器与 POST 测试：
 * - buildBody：resource 内置键不可被 resourceAttributes 覆盖
 * - postSpans：成功/非 200/超时（Bug 2：无超时会挂死 pump 与卸载流程）
 */
import test from "node:test"
import assert from "node:assert/strict"
import { buildBody, postSpans, type SpanRecord } from "../src/otlp.js"
import { startServer, type TestServer } from "./helpers.js"

const span: SpanRecord = {
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  name: "test span",
  kind: 3,
  startTimeUnixNano: 1_000n,
  endTimeUnixNano: 2_000n,
  attributes: [["test.key", "value"]],
  status: { code: 1 },
}

test("buildBody：内置 resource 键优先，自定义属性并入", () => {
  const body = buildBody([span], {
    project: "proj-x",
    resourceAttributes: { "service.name": "evil-override", team: "core" },
  })
  assert.ok(body.includes(Buffer.from("opencode-genai-obs", "utf-8")), "service.name 内置值必须在")
  assert.ok(!body.includes("evil-override"), "resourceAttributes 不得覆盖内置 service.name")
  assert.ok(body.includes(Buffer.from("proj-x", "utf-8")), "project 名必须在")
  assert.ok(body.includes(Buffer.from("team", "utf-8")), "自定义属性键必须在")
})

test("postSpans：成功路径带 protobuf 头，且不发送任何后端专属头", async (t) => {
  const server: TestServer = await startServer((_req, res) => {
    res.statusCode = 200
    res.end()
  })
  t.after(() => server.close())
  await postSpans([span], server.url, { project: "p1", timeoutMs: 2_000 })
  assert.strictEqual(server.requests.length, 1)
  assert.strictEqual(server.requests[0]!.path, "/v1/traces")
  assert.strictEqual(server.requests[0]!.headers["content-type"], "application/x-protobuf")
  // 去平台化契约：project 语义只走 resource 属性，不得有 x-project-name 之类后端专属头
  assert.strictEqual(server.requests[0]!.headers["x-project-name"], undefined)
  assert.ok(server.requests[0]!.body.length > 0, "应发送 protobuf body")
})

test("postSpans：非 200 抛错（调用方负责重试）", async (t) => {
  const server = await startServer((_req, res) => {
    res.statusCode = 500
    res.end("boom")
  })
  t.after(() => server.close())
  await assert.rejects(postSpans([span], server.url, { timeoutMs: 2_000 }), /OTLP export failed: 500/)
})

test("Bug 2：对端挂死时 postSpans 按超时中止，不再永久 pending", async (t) => {
  // 收到请求但永不响应（模拟 Phoenix 半开/被 SIGSTOP）
  const server = await startServer(() => {})
  t.after(() => server.close())
  const start = Date.now()
  await assert.rejects(
    postSpans([span], server.url, { timeoutMs: 150 }),
    (error: Error) => /abort|timeout/i.test(error.name + error.message),
  )
  const elapsed = Date.now() - start
  assert.ok(elapsed < 3_000, `应在超时后很快拒绝（实际 ${elapsed}ms）`)
})
