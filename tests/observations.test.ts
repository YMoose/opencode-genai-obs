import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { LoggerProvider } from "@opentelemetry/sdk-logs"
import type { LogRecord } from "@opentelemetry/api-logs"
import { createSpanBuilder, type SpanBuilderOptions } from "../src/spans.js"
import { createWireRecorder } from "../src/wire.js"
import { createLogs } from "../src/logs.js"
import { toolSpanId, turnSpanId } from "../src/ids.js"
import type { SpanRecord } from "../src/otlp.js"
import type { MetricObservation } from "../src/metrics.js"
import type { CapturedWireFrame } from "../src/types.js"
import { tempDir, waitFor } from "./helpers.js"

const GATES = { userPrompts: true, assistantResponses: true, toolDetails: true, toolContent: true, wireBody: true }

function capture(options: Partial<SpanBuilderOptions> = {}) {
  const spans: SpanRecord[] = []
  const metrics: MetricObservation[] = []
  const builder = createSpanBuilder({
    gates: GATES,
    contentMaxLength: -1,
    agentNameTemplate: "opencode/{agent}",
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

for (const terminal of ["succeeded", "failed", "interrupted"]) {
  test(`Bug 36: host execution.${terminal} is distinct from a plugin flush`, async () => {
    const { builder, spans, send } = capture()
    send("session.execution." + terminal, 300, { error: { type: "aborted", message: "failure" }, reason: "user" })
    await builder.flushAll()
    const root = spans.find((span) => span.spanId === turnSpanId("parent", "user"))
    const attrs = attributes(root)
    assert.equal(attrs["opencode.observation.end_source"], "host_event")
    assert.equal(attrs["opencode.observation.end_trigger"], "session.execution." + terminal)
    assert.equal(attrs["opencode.observation.terminal_observed"], true)
    assert.equal(attrs["opencode.interrupt.reason"], terminal === "interrupted" ? "user" : undefined)
  })
}

test("Bug 36: unload marks tools, turns, containers and compactions without claiming host termination", async () => {
  const { builder, spans, send } = capture()
  send("session.tool.input.started", 210, { id: "call", name: "subagent", assistantMessageID: "assistant" })
  send("session.compaction.started", 220, { reason: "auto" })
  send("session.created", 230, { sessionID: "child", parentID: "parent", agent: "actor" })
  send("session.step.started", 240, { sessionID: "child", assistantMessageID: "child-assistant" })
  await builder.flushAll()
  assert.equal(spans.length, 4)
  for (const span of spans) {
    const attrs = attributes(span)
    assert.equal(attrs["opencode.observation.end_source"], "plugin_flush")
    assert.equal(attrs["opencode.observation.end_trigger"], "plugin_unload")
    assert.equal(attrs["opencode.observation.terminal_observed"], false)
    assert.equal(attrs["opencode.interrupt.reason"], undefined)
    assert.equal(span.status.code, span.name === "compaction" ? 1 : 2)
  }
})

test("Bug 36: chat, tool and compaction terminals preserve their exact event sources", () => {
  const { spans, send } = capture()
  send("session.tool.input.started", 210, { id: "call", name: "shell", assistantMessageID: "assistant" })
  send("session.tool.success", 220, { id: "call" })
  send("session.step.ended", 230, { assistantMessageID: "assistant" })
  send("session.compaction.started", 240, { reason: "auto" })
  send("session.compaction.failed", 250, { error: { type: "aborted" } })
  for (const [name, trigger] of [["execute_tool shell", "session.tool.success"], ["chat model", "session.step.ended"], ["compaction", "session.compaction.failed"]]) {
    const attrs = attributes(spans.find((span) => span.name === name))
    assert.equal(attrs["opencode.observation.end_source"], "host_event")
    assert.equal(attrs["opencode.observation.end_trigger"], trigger)
    assert.equal(attrs["opencode.observation.terminal_observed"], true)
  }
})

test("Bug 36: replacement and deletion do not pretend to observe execution terminals", async () => {
  const { builder, spans, send } = capture()
  builder.handlePrompt("parent", "next-user", "next")
  send("session.step.started", 300, { assistantMessageID: "next-assistant" })
  send("session.deleted", 400)
  await builder.flushAll()
  const first = attributes(spans.find((span) => span.spanId === turnSpanId("parent", "user")))
  const second = attributes(spans.find((span) => span.spanId === turnSpanId("parent", "next-user")))
  assert.equal(first["opencode.observation.end_source"], "plugin_flush")
  assert.equal(first["opencode.observation.end_trigger"], "new_prompt")
  assert.equal(first["opencode.observation.terminal_observed"], false)
  assert.equal(second["opencode.observation.end_source"], "host_event")
  assert.equal(second["opencode.observation.end_trigger"], "session.deleted")
  assert.equal(second["opencode.observation.terminal_observed"], false)
})

test("Bug 36: a replaced compaction has no observed terminal even though its legacy status is OK", () => {
  const { spans, send } = capture()
  send("session.compaction.started", 300, { reason: "auto" })
  send("session.compaction.started", 400, { reason: "auto" })
  const span = spans.find((item) => item.name === "compaction")
  const attrs = attributes(span)
  assert.equal(attrs["opencode.observation.end_source"], "plugin_flush")
  assert.equal(attrs["opencode.observation.end_trigger"], "compaction_replaced")
  assert.equal(attrs["opencode.observation.terminal_observed"], false)
  assert.equal(span?.status.code, 1)
})

test("Bug 37: recorder recreation keeps wire-to-span identity unique when seq restarts", async (t) => {
  const directory = tempDir("ocg-capture-identity-")
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const emitted: SpanRecord[] = []
  for (const hook of ["ws", "http"]) {
    const wire = createWireRecorder({ enabled: true, directory, maxFrameBytes: 0 }, () => {})
    t.after(() => wire.dispose())
    const event = { sessionID: "parent", agent: "reasoner", model: { providerID: "p", id: "m" }, kind: "primary" }
    if (hook === "ws") wire.recordWsSend({ ...event, frame: "request one" })
    else wire.recordHttpRequest({ ...event, request: new Request("http://example.test", { method: "POST", body: "request two" }) })
    let pending: CapturedWireFrame | undefined
    await waitFor(() => (pending = wire.consumePending("parent")) !== undefined)
    const { spans, send } = capture({ consumeWire: () => pending, gates: { ...GATES, wireBody: false } })
    send("session.step.ended", 300, { assistantMessageID: "assistant" })
    emitted.push(...spans)
    wire.recordWsSend({ ...event, sessionID: "other", frame: "next request" })
    await wire.dispose()
  }
  const records = readFileSync(join(directory, "parent.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line))
  assert.equal(records.length, 2)
  assert.equal(emitted.length, 2)
  assert.equal(records[0].seq, 1)
  assert.equal(records[1].seq, 1)
  assert.match(records[0].captureID, /^[0-9a-f-]{36}$/)
  assert.notEqual(records[0].captureID, records[1].captureID)
  const other = readFileSync(join(directory, "other.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line))
  assert.equal(other.length, 2)
  for (const [index, span] of emitted.entries()) {
    const attrs = attributes(span)
    assert.equal(attrs["opencode.wire.capture_id"], records[index].captureID)
    assert.equal(attrs["opencode.wire.seq"], records[index].seq)
    assert.equal(attrs["input.value"], undefined)
    assert.equal(records[index].frame, "")
    assert.equal(other[index].seq, 2)
    assert.equal(other[index].captureID, records[index].captureID)
  }
})
