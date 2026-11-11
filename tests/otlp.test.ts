/**
 * otlp.ts tests (official OTLPTraceExporter-backed):
 * - resource: builtin keys cannot be overridden by resourceAttributes; project rides
 *   openinference.project.name on the resource (de-platforming: never a custom header)
 * - exportBatch: success / failure (ExportResultCode.FAILED rejects for the retry queue)
 * - Bug 2: a hung peer resolves by timeout instead of pending forever — the SDK swallows
 *   failures into FAILED, so the sender's drain can never hang on a half-open backend
 */
import test from "node:test"
import assert from "node:assert/strict"
import { createTraceExporter, type SpanRecord } from "../src/otlp.js"
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

test("resource: project is pinned, service.name is user-overridable (OTEL_SERVICE_NAME chain)", async (t) => {
  const server: TestServer = await startServer((_req, res) => {
    res.statusCode = 200
    res.end()
  })
  t.after(() => server.close())
  const exporter = createTraceExporter({
    endpoint: server.url,
    project: "proj-x",
    resourceAttributes: { "service.name": "org-opencode", "openinference.project.name": "evil-project", team: "core" },
  })
  await exporter.exportBatch([span])
  await exporter.close()
  assert.strictEqual(server.requests.length, 1)
  const body = server.requests[0]!.body
  assert.ok(body.includes("org-opencode"), "service.name override must reach the resource")
  assert.ok(!body.includes("evil-project"), "resourceAttributes must not override the pinned project")
  assert.ok(body.includes("proj-x"), "the project name must be present")
  assert.ok(body.includes("team"), "custom attribute keys must be present")
})

test("exportBatch: success posts protobuf to /v1/traces with no backend-specific headers", async (t) => {
  const server: TestServer = await startServer((_req, res) => {
    res.statusCode = 200
    res.end()
  })
  t.after(() => server.close())
  const exporter = createTraceExporter({ endpoint: server.url, project: "p1" })
  await exporter.exportBatch([span])
  await exporter.close()
  assert.strictEqual(server.requests.length, 1)
  assert.strictEqual(server.requests[0]!.path, "/v1/traces")
  assert.strictEqual(server.requests[0]!.headers["content-type"], "application/x-protobuf")
  // De-platforming contract: the project semantic rides resource attributes only — no backend-specific headers like x-project-name
  assert.strictEqual(server.requests[0]!.headers["x-project-name"], undefined)
  assert.ok(server.requests[0]!.body.length > 0, "must send a protobuf body")
  assert.ok(server.requests[0]!.body.includes("test span"), "the span must be in the body")
  assert.ok(server.requests[0]!.body.includes("test.key"), "attributes must survive the adapter")
})

test("exportBatch: non-200 rejects (the sender owns retries)", async (t) => {
  const server = await startServer((_req, res) => {
    res.statusCode = 500
    res.end("boom")
  })
  t.after(() => server.close())
  const exporter = createTraceExporter({ endpoint: server.url, timeoutMs: 2_000 })
  await assert.rejects(exporter.exportBatch([span]))
  await exporter.close()
})

test("Bug 2 (exporter path): a hung peer resolves by timeout instead of pending forever", async (t) => {
  // accepts the request but never responds (simulates a half-open / SIGSTOPped backend)
  const server = await startServer(() => {})
  t.after(() => server.close())
  const exporter = createTraceExporter({ endpoint: server.url, timeoutMs: 150 })
  const start = Date.now()
  // The SDK resolves failures as ExportResultCode.FAILED (never throws) — either way the
  // promise must settle promptly so the sender's drain cannot hang on unload
  await exporter.exportBatch([span]).catch(() => {})
  const elapsed = Date.now() - start
  assert.ok(elapsed < 3_000, `must settle promptly after the timeout (actual: ${elapsed}ms)`)
  await exporter.close()
})

// ---------------------------------------------------------------- Bug 42 (array-valued attributes)

// gen_ai.response.finish_reasons is string[] per the GenAI semconv (Bug 42). OTLP protobuf
// byte signatures pinned on the real encode path (Bug 28 precedent): after each attribute
// key comes the KeyValue wrapper (\u0012 <len>) then the AnyValue — field 1 stringValue
// (\u000A), field 3 intValue (\u0018), field 5 arrayValue (\u002A); a kvlist mis-encoding
// would be field 6 (\u0032). The pinned otlp-transformer 0.219.0 was probed before this
// landed: toAnyValue's Array.isArray branch precedes its Object.keys branch, so arrays
// encode NATIVELY as arrayValue — these signatures guard that behavior forever.
const FINISH_ARRAY_VALUE =
  "gen_ai.response.finish_reasons\u0012\u000A\u002A\u0008\u000A\u0006\u000A\u0004stop"
const STRING_SCALAR = "test.string\u0012\u0007\u000A\u0005value"
const INT_SCALAR = "test.int\u0012\u0002\u0018\u0007"

test("Bug 42: an array attribute serializes as OTLP arrayValue, not a kvlist or JSON string; scalars keep their forms", async (t) => {
  const server: TestServer = await startServer((_req, res) => {
    res.statusCode = 200
    res.end()
  })
  t.after(() => server.close())
  const exporter = createTraceExporter({ endpoint: server.url })
  await exporter.exportBatch([
    { ...span, attributes: [["gen_ai.response.finish_reasons", ["stop"]], ["test.string", "value"], ["test.int", 7]] },
  ])
  await exporter.close()
  assert.strictEqual(server.requests.length, 1)
  const body = server.requests[0]!.body
  // arrayValue{values:[{stringValue:"stop"}]} — the full byte sequence is pinned, so a
  // kvlist-with-numeric-keys or plain-stringValue encoding cannot satisfy it
  assert.ok(body.includes(FINISH_ARRAY_VALUE), "must serialize as arrayValue holding stringValue \"stop\"")
  // the pre-Bug-42 form: a JSON-encoded string carrying the literal text ["stop"]
  assert.ok(!body.includes('["stop"]'), "must NOT serialize as a JSON-encoded string")
  // scalar guards: encodings unchanged by the AttrValue widening
  assert.ok(body.includes(STRING_SCALAR), "string scalars still encode as stringValue")
  assert.ok(body.includes(INT_SCALAR), "int scalars still encode as intValue")
})
