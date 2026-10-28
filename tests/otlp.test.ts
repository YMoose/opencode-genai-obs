/**
 * otlp.ts encoder and POST tests:
 * - buildBody: builtin resource keys cannot be overridden by resourceAttributes
 * - postSpans: success / non-200 / timeout (Bug 2: no timeout would hang the pump and unload)
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

test("buildBody: builtin resource keys win, custom attributes are merged in", () => {
  const body = buildBody([span], {
    project: "proj-x",
    resourceAttributes: { "service.name": "evil-override", team: "core" },
  })
  assert.ok(body.includes(Buffer.from("opencode-genai-obs", "utf-8")), "the builtin service.name must be present")
  assert.ok(!body.includes("evil-override"), "resourceAttributes must not override the builtin service.name")
  assert.ok(body.includes(Buffer.from("proj-x", "utf-8")), "the project name must be present")
  assert.ok(body.includes(Buffer.from("team", "utf-8")), "custom attribute keys must be present")
})

test("postSpans: success path sends the protobuf content type and no backend-specific headers", async (t) => {
  const server: TestServer = await startServer((_req, res) => {
    res.statusCode = 200
    res.end()
  })
  t.after(() => server.close())
  await postSpans([span], server.url, { project: "p1", timeoutMs: 2_000 })
  assert.strictEqual(server.requests.length, 1)
  assert.strictEqual(server.requests[0]!.path, "/v1/traces")
  assert.strictEqual(server.requests[0]!.headers["content-type"], "application/x-protobuf")
  // De-platforming contract: the project semantic rides resource attributes only — no backend-specific headers like x-project-name
  assert.strictEqual(server.requests[0]!.headers["x-project-name"], undefined)
  assert.ok(server.requests[0]!.body.length > 0, "must send a protobuf body")
})

test("postSpans: non-200 throws (the caller owns retries)", async (t) => {
  const server = await startServer((_req, res) => {
    res.statusCode = 500
    res.end("boom")
  })
  t.after(() => server.close())
  await assert.rejects(postSpans([span], server.url, { timeoutMs: 2_000 }), /OTLP export failed: 500/)
})

test("Bug 2: a hung peer aborts postSpans by timeout instead of pending forever", async (t) => {
  // accepts the request but never responds (simulates a half-open / SIGSTOPped backend)
  const server = await startServer(() => {})
  t.after(() => server.close())
  const start = Date.now()
  await assert.rejects(
    postSpans([span], server.url, { timeoutMs: 150 }),
    (error: Error) => /abort|timeout/i.test(error.name + error.message),
  )
  const elapsed = Date.now() - start
  assert.ok(elapsed < 3_000, `must reject promptly after the timeout (actual: ${elapsed}ms)`)
})
