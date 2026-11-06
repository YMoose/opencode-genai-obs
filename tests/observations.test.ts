import test from "node:test"
import assert from "node:assert/strict"
import { LoggerProvider } from "@opentelemetry/sdk-logs"
import type { LogRecord } from "@opentelemetry/api-logs"
import { createSpanBuilder, type SpanBuilderOptions } from "../src/spans.js"
import { createLogs } from "../src/logs.js"
import { toolSpanId } from "../src/ids.js"
import type { SpanRecord } from "../src/otlp.js"
import type { MetricObservation } from "../src/metrics.js"

const GATES = { userPrompts: true, assistantResponses: true, toolDetails: true, toolContent: true, wireBody: true }

function capture(options: Partial<SpanBuilderOptions> = {}) {
  const spans: SpanRecord[] = []
  const metrics: MetricObservation[] = []
  const builder = createSpanBuilder({
    gates: GATES,
    contentMaxLength: -1,
    consumeWire: () => undefined,
    observe: (observation) => metrics.push(observation),
    ...options,
  }, (span) => spans.push(span), () => {})
  const send = (type: string, created: number, data: Record<string, unknown> = {}) => {
    builder.handleEvent({ type, created, data: { sessionID: "parent", ...data } })
  }
  send("session.created", 100)
  builder.handlePrompt("parent", "user", "question")
  send("session.step.started", 200, { assistantMessageID: "assistant", model: { id: "model", providerID: "provider" } })
  return { builder, spans, metrics, send }
}

function attributes(span: SpanRecord | undefined) {
  assert.ok(span, "the expected span must be emitted")
  return Object.fromEntries(span.attributes)
}

for (const name of ["subagent", "task", "shell"]) {
  test(`Bug 35: ${name} exports child identity only from delegation metadata with content gated`, () => {
    const { spans, send } = capture({ gates: { ...GATES, toolDetails: false, toolContent: false } })
    send("session.tool.input.started", 210, { id: "call", name, assistantMessageID: "assistant" })
    send("session.tool.called", 220, { id: "call", input: { sessionID: "requested-child", agent: "actor" } })
    send("session.tool.success", 230, { id: "call", metadata: { sessionID: "actual-child" }, content: [{ type: "text", text: "private result" }] })
    const tool = spans.find((span) => span.spanId === toolSpanId("assistant", "call"))
    const attrs = attributes(tool)
    assert.equal(attrs["opencode.subagent.session_id"], name === "shell" ? undefined : "actual-child")
    assert.equal(attrs["gen_ai.conversation.id"], "parent")
    assert.equal(attrs["gen_ai.tool.call.arguments"], undefined)
    assert.equal(attrs["gen_ai.tool.call.result"], undefined)
    assert.equal(attrs["error.type"], undefined)
  })
}

test("Bug 35: missing or malformed metadata never infers a child from arguments or result text", () => {
  for (const sessionID of [undefined, "", 123]) {
    const { spans, send } = capture()
    send("session.tool.input.started", 210, { id: "call", name: "subagent", assistantMessageID: "assistant" })
    send("session.tool.called", 220, { id: "call", input: { sessionID: "requested-child" } })
    send("session.tool.success", 230, { id: "call", metadata: { sessionID }, content: [{ type: "text", text: '<subagent sessionID="quoted-child">example</subagent>' }] })
    assert.equal(attributes(spans[0])["opencode.subagent.session_id"], undefined)
  }
})

for (const errorType of ["aborted", "interrupted", undefined, ""]) {
  test(`Bug 35: tool error type ${String(errorType)} agrees between spans and metrics`, () => {
    const { spans, metrics, send } = capture()
    send("session.tool.input.started", 210, { id: "call", name: "subagent", assistantMessageID: "assistant" })
    send("session.tool.failed", 230, { id: "call", error: { type: errorType, message: "failure" }, metadata: { sessionID: "child" } })
    assert.equal(attributes(spans[0])["error.type"], errorType || "tool_error")
    assert.equal(attributes(spans[0])["opencode.subagent.session_id"], "child")
    const duration = metrics.find((metric) => metric.metric === "duration")
    assert.ok(duration?.metric === "duration")
    assert.equal(duration.errorType, errorType || "tool_error")
  })
}

test("Bug 35: tool message events preserve the same error types as spans with content gated", async (t) => {
  const records: LogRecord[] = []
  t.mock.method(LoggerProvider.prototype, "getLogger", () => ({ emit: (record: LogRecord) => records.push(record) }))
  const logs = createLogs({ endpoint: "http://unused.test", contentMaxLength: 0 })
  t.after(() => logs.shutdown())
  for (const errorType of ["aborted", "interrupted", undefined, ""]) {
    const { spans, send } = capture({ emitLogEvent: logs.emit, gates: { ...GATES, toolContent: false } })
    send("session.tool.input.started", 210, { id: "call", name: "shell", assistantMessageID: "assistant" })
    send("session.tool.failed", 230, { id: "call", error: { type: errorType, message: "failure" } })
    const record = records.filter((item) => item.eventName === "gen_ai.tool.message").at(-1)
    assert.equal(record?.attributes?.["error.type"], attributes(spans[0])["error.type"])
  }
  const { send } = capture({ emitLogEvent: logs.emit })
  send("session.tool.input.started", 210, { id: "call", name: "shell", assistantMessageID: "assistant" })
  send("session.tool.success", 230, { id: "call" })
  assert.equal(records.filter((item) => item.eventName === "gen_ai.tool.message").at(-1)?.attributes?.["error.type"], undefined)
})
