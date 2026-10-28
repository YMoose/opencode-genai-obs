/**
 * probe.ts tests (startup OTLP endpoint liveness, idea adapted from
 * DEVtheOPS/opencode-plugin-otel probe.test.ts — re-implemented for our
 * HTTP-only, log-only diagnostic design):
 * - parseEndpoint: default ports for http/https, explicit ports, invalid URLs
 * - probeEndpoint: reachable host, refused connection, invalid URL
 */
import test from "node:test"
import assert from "node:assert/strict"
import { parseEndpoint, probeEndpoint, collectProbeTargets } from "../src/probe.js"
import { startServer } from "./helpers.js"

test("parseEndpoint: http defaults to 80, https to 443, explicit port wins, paths are ignored", () => {
  assert.deepStrictEqual(parseEndpoint("http://api.honeycomb.io"), { host: "api.honeycomb.io", port: 80 })
  assert.deepStrictEqual(parseEndpoint("https://api.honeycomb.io"), { host: "api.honeycomb.io", port: 443 })
  assert.deepStrictEqual(parseEndpoint("http://localhost:4318/v1/traces"), { host: "localhost", port: 4318 })
})

test("parseEndpoint: invalid or non-HTTP URLs return null (we are OTLP/HTTP-only by design)", () => {
  assert.strictEqual(parseEndpoint("not a url"), null)
  assert.strictEqual(parseEndpoint("grpc://collector:4317"), null, "gRPC is out of scope — the probe only speaks to HTTP endpoints")
})

test("probeEndpoint: reachable host reports ok with a latency", async (t) => {
  const server = await startServer((_req, res) => {
    res.statusCode = 200
    res.end()
  })
  t.after(() => server.close())

  const result = await probeEndpoint(server.url)
  assert.strictEqual(result.ok, true)
  assert.ok(result.ms >= 0, "latency is measured")
  assert.strictEqual(result.error, undefined)
})

test("probeEndpoint: refused connection reports the error, never throws", async () => {
  const result = await probeEndpoint("http://127.0.0.1:19999")
  assert.strictEqual(result.ok, false)
  assert.ok(result.error, "the refusal reason is reported")
  assert.ok(result.ms >= 0)
})

test("probeEndpoint: invalid URL fails fast without touching the network", async () => {
  const result = await probeEndpoint("not a url at all")
  assert.strictEqual(result.ok, false)
  assert.ok(result.error!.includes("invalid endpoint"))
})

test("collectProbeTargets: signals sharing an endpoint probe once; distinct endpoints probe separately", () => {
  const targets = collectProbeTargets([
    { label: "traces", endpoint: "http://localhost:6006" },
    { label: "metrics", endpoint: "http://localhost:6006" },
    { label: "logs", endpoint: "http://collector:4318" },
  ])
  assert.deepStrictEqual(targets, [
    { label: "traces+metrics", endpoint: "http://localhost:6006" },
    { label: "logs", endpoint: "http://collector:4318" },
  ])
})
