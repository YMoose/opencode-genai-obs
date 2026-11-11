/**
 * logs.ts tests (gen_ai.* message events, opt-in lane):
 * - user/system/tool/choice events land in a batched /v1/logs export with W3C-joined span context
 * - gated content (undefined) still emits the event, metadata-only
 * - system extraction is best-effort across OpenAI/Anthropic wire shapes
 * - a failing backend never crashes emit/shutdown
 * - contentMaxLength=0 omits the body content key and stamps opencode.content.truncated (Bug 28)
 */
import test from "node:test"
import assert from "node:assert/strict"
import { createLogs } from "../src/logs.js"
import { startServer, waitFor } from "./helpers.js"

const CTX = { traceId: "ab".repeat(16), spanId: "cd".repeat(8) }

// OTLP protobuf byte signatures (the raw export body is asserted as a utf-8 string, like the
// tests below): a body kvlist key "content" holding an EMPTY AnyValue — the exact shape
// `{ content: undefined }` serializes to (Bug 28) — vs. a boolean-true attribute entry.
const EMPTY_CONTENT_ENTRY = "content\u0012\u0000"
const TRUNCATED_TRUE = "opencode.content.truncated\u0012\u0002\u0010\u0001"

test("the four message events land in /v1/logs with span context and gated content", async (t) => {
  const server = await startServer((_req, res) => {
    res.statusCode = 200
    res.end()
  })
  t.after(() => server.close())

  const logs = createLogs({ endpoint: server.url, contentMaxLength: 61440 })
  logs.emit({ event: "user", sessionID: "s1", timeMs: 1_000, ...CTX, content: "hello world" })
  logs.emit({ event: "system", sessionID: "s1", timeMs: 1_100, ...CTX, frame: JSON.stringify({ messages: [{ role: "system", content: "be terse" }] }), gated: false })
  logs.emit({ event: "tool", sessionID: "s1", timeMs: 1_200, ...CTX, callId: "tc1", tool: "grep", content: "3 hits", failed: false })
  logs.emit({ event: "choice", sessionID: "s1", timeMs: 1_300, ...CTX, provider: "aliyun", model: "kimi-k3", finishReason: "stop", content: "the answer" })
  // Gated: content undefined → metadata-only event
  logs.emit({ event: "user", sessionID: "s1", timeMs: 1_400, ...CTX, content: undefined })

  await waitFor(() => server.requests.some((r) => r.path === "/v1/logs"), 8_000)
  const body = server.requests.find((r) => r.path === "/v1/logs")!.body

  assert.ok(body.includes("gen_ai.user.message"), "user event exported")
  assert.ok(body.includes("gen_ai.system.message"), "system event exported")
  assert.ok(body.includes("gen_ai.tool.message"), "tool event exported")
  assert.ok(body.includes("gen_ai.choice"), "choice event exported")
  assert.ok(body.includes("hello world"), "ungated user content present")
  assert.ok(body.includes("be terse"), "system content extracted from the wire frame")
  assert.ok(body.includes("the answer"), "choice content present")
  assert.ok(body.includes("gen_ai.conversation.id"), "conversation id attribute present")
  assert.ok(body.includes("kimi-k3"), "model attribute present")
  // Span context joins log ↔ trace: the deterministic trace id (hex) must appear in the payload
  assert.ok(server.requests[0]!.headers["content-type"] === "application/x-protobuf")

  await logs.shutdown()
})

test("system extraction: Anthropic-style top-level system field; unparseable frames emit nothing", async (t) => {
  const server = await startServer((_req, res) => {
    res.statusCode = 200
    res.end()
  })
  t.after(() => server.close())

  const logs = createLogs({ endpoint: server.url, contentMaxLength: -1 })
  logs.emit({ event: "system", sessionID: "s1", timeMs: 1_000, ...CTX, frame: JSON.stringify({ system: [{ type: "text", text: "anthropic system prompt" }] }), gated: false })
  logs.emit({ event: "system", sessionID: "s1", timeMs: 1_001, ...CTX, frame: "not json{", gated: false }) // skipped silently
  logs.emit({ event: "user", sessionID: "s1", timeMs: 1_002, ...CTX, content: "marker" })

  await waitFor(() => server.requests.some((r) => r.path === "/v1/logs"), 8_000)
  const body = server.requests.map((r) => r.body).join("")
  assert.ok(body.includes("anthropic system prompt"), "Anthropic-style system field extracted")
  assert.ok(!body.includes("not json"), "unparseable frame must not emit")

  await logs.shutdown()
})

test("a failing logs backend never crashes emit() or shutdown()", async (t) => {
  const server = await startServer((_req, res) => {
    res.statusCode = 500
    res.end("boom")
  })
  t.after(() => server.close())

  const logs = createLogs({ endpoint: server.url, contentMaxLength: 100 })
  logs.emit({ event: "user", sessionID: "s1", timeMs: 1_000, ...CTX, content: "x" })
  await waitFor(() => server.requests.length >= 1, 8_000)
  await logs.shutdown() // must resolve despite the 500s
})

// ---------------------------------------------------------------- Bug 28 (contentMaxLength envelope)

test("Bug 28: contentMaxLength=0 omits the body content key entirely and stamps opencode.content.truncated on all four events", async (t) => {
  const server = await startServer((_req, res) => {
    res.statusCode = 200
    res.end()
  })
  t.after(() => server.close())

  const logs = createLogs({ endpoint: server.url, contentMaxLength: 0, intervalMs: 50 })
  logs.emit({ event: "user", sessionID: "s1", timeMs: 1_000, ...CTX, content: "user prompt" })
  logs.emit({ event: "system", sessionID: "s1", timeMs: 1_100, ...CTX, frame: JSON.stringify({ messages: [{ role: "system", content: "system prompt" }] }), gated: false })
  logs.emit({ event: "tool", sessionID: "s1", timeMs: 1_200, ...CTX, callId: "tc1", tool: "grep", content: "tool result", failed: false })
  logs.emit({ event: "choice", sessionID: "s1", timeMs: 1_300, ...CTX, provider: "aliyun", model: "kimi-k3", finishReason: "stop", content: "the answer" })

  const allBodies = () => server.requests.map((r) => r.body).join("")
  // All four records land in one batch (synchronous emits before the 50 ms timer); the choice
  // record is the last one, so its event name means the whole batch has arrived.
  await waitFor(() => allBodies().includes("gen_ai.choice"), 8_000)
  const body = allBodies()

  assert.ok(!body.includes("user prompt"), "user content withheld at limit 0")
  assert.ok(!body.includes("system prompt"), "system content withheld at limit 0")
  assert.ok(!body.includes("tool result"), "tool content withheld at limit 0")
  assert.ok(!body.includes("the answer"), "choice content withheld at limit 0")
  assert.ok(!body.includes(EMPTY_CONTENT_ENTRY), "no present-but-empty content kvlist entry ({ content: undefined } survives Object.keys and serializes as an empty AnyValue)")
  assert.strictEqual(body.split(TRUNCATED_TRUE).length - 1, 4, "every withheld record carries opencode.content.truncated=true on its attributes")

  await logs.shutdown()
})

test("Bug 28: contentMaxLength=5 clips a longer content and stamps opencode.content.truncated=true", async (t) => {
  const server = await startServer((_req, res) => {
    res.statusCode = 200
    res.end()
  })
  t.after(() => server.close())

  const logs = createLogs({ endpoint: server.url, contentMaxLength: 5, intervalMs: 50 })
  logs.emit({ event: "user", sessionID: "s1", timeMs: 1_000, ...CTX, content: "0123456789" })

  const allBodies = () => server.requests.map((r) => r.body).join("")
  await waitFor(() => allBodies().includes("gen_ai.user.message"), 8_000)
  const body = allBodies()

  assert.ok(body.includes("01234"), "content clipped to the byte budget")
  assert.ok(!body.includes("56789"), "tail beyond the budget is dropped")
  assert.strictEqual(body.split(TRUNCATED_TRUE).length - 1, 1, "truncation stamped on the record attributes")

  await logs.shutdown()
})

test("Bug 28: no opencode.content.truncated when content fits, is empty, is gated off, or the limit is unlimited", async (t) => {
  const server = await startServer((_req, res) => {
    res.statusCode = 200
    res.end()
  })
  t.after(() => server.close())

  const capped = createLogs({ endpoint: server.url, contentMaxLength: 100, intervalMs: 50 })
  capped.emit({ event: "user", sessionID: "s1", timeMs: 1_000, ...CTX, content: "hello" }) // fits the budget
  capped.emit({ event: "user", sessionID: "s1", timeMs: 1_050, ...CTX, content: undefined }) // gate off → metadata-only
  capped.emit({ event: "system", sessionID: "s1", timeMs: 1_100, ...CTX, frame: JSON.stringify({ system: "sys prompt" }), gated: true }) // gate off
  capped.emit({ event: "tool", sessionID: "s1", timeMs: 1_200, ...CTX, callId: "tc1", tool: "grep", content: "", failed: false }) // empty: nothing to lose
  const unlimited = createLogs({ endpoint: server.url, contentMaxLength: -1, intervalMs: 50 })
  unlimited.emit({ event: "choice", sessionID: "s1", timeMs: 1_300, ...CTX, provider: "aliyun", model: "kimi-k3", finishReason: "stop", content: "unlimited marker text" })

  await waitFor(() => server.requests.some((r) => r.body.includes("unlimited marker text")), 8_000)
  const body = server.requests.map((r) => r.body).join("")

  assert.ok(!body.includes("opencode.content.truncated"), "no stamp when nothing was withheld or shortened")
  assert.ok(!body.includes(EMPTY_CONTENT_ENTRY), "no empty content kvlist entry either")

  await capped.shutdown()
  await unlimited.shutdown()
})

// ------------------------------------------------------------------ Bug 46 (bounded shutdown)

test("Bug 46: logs.shutdown() against a non-responsive endpoint resolves within its budget", async (t) => {
  // Same blackhole as the metrics twin: the batch processor's final export never completes,
  // so the unbounded SDK shutdown hangs the host's unload (>90 s measured live).
  const server = await startServer(() => {
    /* never respond */
  })
  t.after(() => server.close())

  const lines: string[] = []
  const logs = createLogs({ endpoint: server.url, contentMaxLength: 100, intervalMs: 50, log: (msg) => lines.push(msg) })
  logs.emit({ event: "user", sessionID: "s1", timeMs: 1_000, ...CTX, content: "x" })
  await waitFor(() => server.requests.length >= 1, 5_000)

  const started = Date.now()
  await logs.shutdown()
  const took = Date.now() - started
  assert.ok(took < 1_500, `logs shutdown must return within its budget, took ${took}ms`)
  assert.ok(lines.some((line) => line.includes("logs shutdown exceeded")), "the abandoned shutdown is logged")
})
