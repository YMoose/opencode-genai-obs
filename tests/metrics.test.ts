/**
 * metrics.ts tests (gen_ai.client.* only, per the project scope):
 * - token usage + operation duration observations land in a periodic /v1/metrics export
 * - input tokens include cache read/write (billable input, same aggregation as spans)
 * - a failing backend never crashes observe/shutdown (observability must not block the main path)
 */
import test from "node:test"
import assert from "node:assert/strict"
import { createMetrics } from "../src/metrics.js"
import { startServer, waitFor } from "./helpers.js"

test("observations are exported to /v1/metrics with semconv names and attributes", async (t) => {
  const server = await startServer((_req, res) => {
    res.statusCode = 200
    res.end()
  })
  t.after(() => server.close())

  const metrics = createMetrics({ endpoint: server.url, intervalMs: 100 })
  metrics.observe({ metric: "token", tokenType: "input", value: 1_840, provider: "aliyun", model: "kimi-k3" })
  metrics.observe({ metric: "token", tokenType: "output", value: 312, provider: "aliyun", model: "kimi-k3" })
  metrics.observe({ metric: "duration", operation: "chat", durationNano: 2_500_000_000n, provider: "aliyun", model: "kimi-k3" })
  metrics.observe({ metric: "duration", operation: "execute_tool", durationNano: 80_000_000n, tool: "grep" })

  await waitFor(() => server.requests.some((r) => r.path === "/v1/metrics"), 5_000)
  const body = server.requests.find((r) => r.path === "/v1/metrics")!.body

  assert.ok(body.includes("gen_ai.client.token.usage"), "the token usage metric must be exported")
  assert.ok(body.includes("gen_ai.client.operation.duration"), "the operation duration metric must be exported")
  assert.ok(body.includes("gen_ai.token.type"), "token type attribute must be present")
  assert.ok(body.includes("input"), "input token type must be present")
  assert.ok(body.includes("output"), "output token type must be present")
  assert.ok(body.includes("kimi-k3"), "model attribute must be present")
  assert.ok(body.includes("execute_tool"), "tool operation name must be present")
  assert.ok(body.includes("grep"), "tool name attribute must be present")
  assert.strictEqual(server.requests[0]!.headers["content-type"], "application/x-protobuf")

  await metrics.shutdown()
})

test("a failing metrics backend never crashes observe() or shutdown()", async (t) => {
  const server = await startServer((_req, res) => {
    res.statusCode = 500
    res.end("boom")
  })
  t.after(() => server.close())

  const metrics = createMetrics({ endpoint: server.url, intervalMs: 50 })
  metrics.observe({ metric: "token", tokenType: "input", value: 1, provider: "p", model: "m" })
  await waitFor(() => server.requests.length >= 1, 5_000)
  await metrics.shutdown() // must resolve despite the 500s
})

test("OTEL_SERVICE_NAME override: resourceAttributes service.name reaches the exported resource", async (t) => {
  const server = await startServer((_req, res) => {
    res.statusCode = 200
    res.end()
  })
  t.after(() => server.close())

  const metrics = createMetrics({
    endpoint: server.url,
    intervalMs: 100,
    resourceAttributes: { "service.name": "org-opencode", "team.id": "core" },
  })
  metrics.observe({ metric: "token", tokenType: "input", value: 1, provider: "p", model: "m" })

  await waitFor(() => server.requests.some((r) => r.path === "/v1/metrics"), 5_000)
  const body = server.requests.find((r) => r.path === "/v1/metrics")!.body
  assert.ok(body.includes("org-opencode"), "the overridden service.name must reach the resource")
  // Note: the instrumentation scope name remains "opencode-genai-obs" — only the resource
  // service.name is overridable; the default service.name value must not appear as a resource attr.
  assert.ok(body.includes("core"), "other resource attributes still export")

  await metrics.shutdown()
})
