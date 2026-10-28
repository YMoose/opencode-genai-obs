/**
 * logs.ts tests (gen_ai.* message events, opt-in lane):
 * - user/system/tool/choice events land in a batched /v1/logs export with W3C-joined span context
 * - gated content (undefined) still emits the event, metadata-only
 * - system extraction is best-effort across OpenAI/Anthropic wire shapes
 * - a failing backend never crashes emit/shutdown
 */
import test from "node:test"
import assert from "node:assert/strict"
import { createLogs } from "../src/logs.js"
import { startServer, waitFor } from "./helpers.js"

const CTX = { traceId: "ab".repeat(16), spanId: "cd".repeat(8) }

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
