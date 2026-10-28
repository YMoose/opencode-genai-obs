/**
 * spans.ts state-machine regression tests:
 * - Deterministic id contract (the trace/span id hash formulas)
 * - Bug 3: empty-prompt turn roots fall back to the title (used to be a constant "(empty)"; the fallback was dead code)
 * - Bug 6: malformed events missing assistantMessageID / tool call id no longer produce fake "undefined"-id spans
 * - Bug 4: session.deleted cleans up session state
 * - Sub-agent sessions get a container span per execution round
 */
import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createSpanBuilder, type SpanBuilderOptions } from "../src/spans.js"
import type { SpanRecord } from "../src/otlp.js"

const hash = (input: string, bytes: number): string =>
  createHash("sha256").update(input).digest("hex").slice(0, bytes * 2)

const GATES = { userPrompts: true, assistantResponses: true, toolDetails: true, toolContent: true, wireBody: true }

interface Harness {
  readonly spans: SpanRecord[]
  readonly builder: ReturnType<typeof createSpanBuilder>
}

function makeHarness(overrides?: Partial<SpanBuilderOptions>): Harness {
  const spans: SpanRecord[] = []
  const builder = createSpanBuilder(
    {
      gates: GATES,
      contentMaxLength: -1,
      consumeWire: () => undefined,
      getSessionInfo: async () => ({ agent: "build", title: "T", directory: "/w/p" }),
      ...overrides,
    },
    (span) => spans.push(span),
    () => {},
  )
  return { spans, builder }
}

/** Wait for async flushes (the void flushTurnRoot of execution.* / session.deleted) to land */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25))

const event = (type: string, created: number, data: Record<string, unknown>) => ({ type, created, data })

test("happy path: turn root + chat span; deterministic ids match the hash formulas", async () => {
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "hello world")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "gpt", providerID: "p" } }))
  builder.handleEvent(event("session.text.ended", 1_200, { sessionID: "s1", assistantMessageID: "a1", text: "answer" }))
  builder.handleEvent(
    event("session.step.ended", 1_300, {
      sessionID: "s1",
      assistantMessageID: "a1",
      tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.01,
    }),
  )
  builder.handleEvent(event("session.execution.succeeded", 1_400, { sessionID: "s1" }))
  await settle()

  const chat = spans.find((span) => span.name === "chat gpt")
  assert.ok(chat, "must emit the chat span")
  assert.strictEqual(chat.spanId, hash("opencode-chat:a1", 8))
  assert.strictEqual(chat.traceId, hash("opencode-turn:s1:m1", 16))

  const root = spans.find((span) => span.spanId === hash("opencode-turn-span:s1:m1", 8))
  assert.ok(root, "must emit the turn root span")
  assert.strictEqual(root.name, "hello world")
  const output = root.attributes.find(([key]) => key === "output.value")
  assert.equal(output?.[1], "answer", "last answer must land in the turn root output.value")
})

test("Bug 3: empty-prompt turn root falls back to the session title, not '(empty)'", async () => {
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.step.ended", 1_200, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.execution.succeeded", 1_300, { sessionID: "s1" }))
  await settle()

  const root = spans.find((span) => span.spanId === hash("opencode-turn-span:s1:m1", 8))
  assert.ok(root, "must emit the turn root span")
  assert.strictEqual(root.name, "T", "empty input must fall back to the getSessionInfo title")
})

test("Bug 6: malformed events missing assistantMessageID / tool id produce no bogus-id span", async () => {
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "q")
  // step.started without assistantMessageID: no step created
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1" }))
  // step.ended without assistantMessageID: no chat span
  builder.handleEvent(event("session.step.ended", 1_200, { sessionID: "s1" }))
  // tool.success without id: no tool span
  builder.handleEvent(event("session.tool.success", 1_250, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.execution.succeeded", 1_300, { sessionID: "s1" }))
  await settle()

  assert.strictEqual(spans.length, 1, "only the turn root must remain")
  const bogusChat = hash("opencode-chat:undefined", 8)
  const bogusTool = hash("opencode-tool:undefined:undefined", 8)
  for (const span of spans) {
    assert.notStrictEqual(span.spanId, bogusChat, "no chat span hashed from 'undefined' may appear")
    assert.notStrictEqual(span.spanId, bogusTool, "no tool span hashed from 'undefined' may appear")
  }
})

test("Bug 4: session.deleted flushes the unfinished turn root and clears that session's state", async () => {
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "q")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.deleted", 1_500, { sessionID: "s1" }))
  await settle()
  const afterDelete = spans.length
  assert.strictEqual(afterDelete, 1, "deletion must flush the unfinished turn root")

  await builder.flushAll()
  assert.strictEqual(spans.length, 1, "flushAll must not produce any span for the deleted session")
})

test("sub-session multi-round execution: each round emits a container span (same deterministic id)", async () => {
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "go")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1" }))
  // sub-agent tool success → registers the s2 attachment point + container
  builder.handleEvent(event("session.tool.input.started", 1_150, { sessionID: "s1", assistantMessageID: "a1", id: "t1", name: "task" }))
  builder.handleEvent(event("session.tool.called", 1_160, { sessionID: "s1", assistantMessageID: "a1", id: "t1", input: { agent: "child" } }))
  builder.handleEvent(
    event("session.tool.success", 1_200, {
      sessionID: "s1",
      assistantMessageID: "a1",
      id: "t1",
      content: [{ type: "text", text: "ok" }],
      metadata: { sessionID: "s2" },
    }),
  )
  // first execution round
  builder.handleEvent(event("session.step.started", 1_300, { sessionID: "s2", assistantMessageID: "c1" }))
  builder.handleEvent(event("session.step.ended", 1_400, { sessionID: "s2", assistantMessageID: "c1" }))
  builder.handleEvent(event("session.execution.succeeded", 1_500, { sessionID: "s2" }))
  // second execution round (same session reused)
  builder.handleEvent(event("session.step.started", 1_600, { sessionID: "s2", assistantMessageID: "c2" }))
  builder.handleEvent(event("session.step.ended", 1_700, { sessionID: "s2", assistantMessageID: "c2" }))
  builder.handleEvent(event("session.execution.succeeded", 1_800, { sessionID: "s2" }))
  await settle()

  const containerId = hash("opencode-session:s2", 8)
  const containers = spans.filter((span) => span.spanId === containerId)
  assert.strictEqual(containers.length, 2, "two execution rounds must each emit one container span")
})

test("user_prompt.length: not affected by the userPrompts gate; always lands on the turn root", async () => {
  const { spans, builder } = makeHarness({ gates: { ...GATES, userPrompts: false } })
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "你好，世界") // 5 chars = 15 UTF-8 bytes
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.step.ended", 1_200, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.execution.succeeded", 1_300, { sessionID: "s1" }))
  await settle()

  const root = spans.find((span) => span.spanId === hash("opencode-turn-span:s1:m1", 8))
  assert.ok(root)
  assert.equal(root.attributes.find(([key]) => key === "opencode.user_prompt.length")?.[1], 15, "not gated, byte size (not char count) still lands in the attribute")
  assert.ok(!root.attributes.some(([key]) => key === "input.value"), "input.value must not appear when the gate is off")
})

test("opencode.session.parent_id: child-agent chat span carries the parent session id; root session does not", async () => {
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "go")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "m", providerID: "p" } }))
  // Register s2 as a sub-agent of s1 via the task tool
  builder.handleEvent(event("session.tool.input.started", 1_150, { sessionID: "s1", assistantMessageID: "a1", id: "t1", name: "task" }))
  builder.handleEvent(event("session.tool.called", 1_160, { sessionID: "s1", assistantMessageID: "a1", id: "t1", input: { agent: "child" } }))
  builder.handleEvent(
    event("session.tool.success", 1_200, {
      sessionID: "s1",
      assistantMessageID: "a1",
      id: "t1",
      content: [{ type: "text", text: "ok" }],
      metadata: { sessionID: "s2" },
    }),
  )
  builder.handleEvent(event("session.step.started", 1_300, { sessionID: "s2", assistantMessageID: "c1", model: { id: "m", providerID: "p" } }))
  builder.handleEvent(event("session.step.ended", 1_400, { sessionID: "s2", assistantMessageID: "c1" }))
  builder.handleEvent(event("session.step.ended", 1_500, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.execution.succeeded", 1_600, { sessionID: "s2" }))
  builder.handleEvent(event("session.execution.succeeded", 1_700, { sessionID: "s1" }))
  await settle()

  const childChat = spans.find((span) => span.spanId === hash("opencode-chat:c1", 8))
  assert.ok(childChat, "must emit the child-agent chat span")
  assert.equal(childChat.attributes.find(([key]) => key === "opencode.session.parent_id")?.[1], "s1", "child-agent chat must carry the parent session id")

  const rootChat = spans.find((span) => span.spanId === hash("opencode-chat:a1", 8))
  assert.ok(rootChat, "must emit the root-session chat span")
  assert.ok(!rootChat.attributes.some(([key]) => key === "opencode.session.parent_id"), "root session must not carry parent_session_id")
})

test("content gate: content=false turns toolDetails/toolContent off by default", async () => {
  const { spans, builder } = makeHarness({
    gates: { ...GATES, toolDetails: false, toolContent: false },
  })
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "q")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.tool.input.started", 1_150, { sessionID: "s1", assistantMessageID: "a1", id: "t1", name: "bash" }))
  builder.handleEvent(event("session.tool.called", 1_160, { sessionID: "s1", assistantMessageID: "a1", id: "t1", input: { cmd: "ls" } }))
  builder.handleEvent(event("session.tool.success", 1_200, { sessionID: "s1", assistantMessageID: "a1", id: "t1", content: [{ type: "text", text: "out" }] }))
  builder.handleEvent(event("session.execution.succeeded", 1_300, { sessionID: "s1" }))
  await settle()

  const tool = spans.find((span) => span.spanId === hash("opencode-tool:a1:t1", 8))
  assert.ok(tool, "must emit the tool span")
  const keys = new Set(tool.attributes.map(([key]) => key))
  assert.ok(!keys.has("gen_ai.tool.call.arguments"), "toolDetails=false must not carry call arguments")
  assert.ok(!keys.has("gen_ai.tool.call.result"), "toolContent=false must not carry the tool result")
})

// ------------------------------------------------------------------ compaction (aligned with #35935)

test("compaction: started→ended becomes its own trace with model/usage/cost/summary", async () => {
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "q")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.step.ended", 1_200, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.compaction.started", 2_000, { sessionID: "s1", reason: "auto" }))
  builder.handleEvent(
    event("session.compaction.ended", 3_000, {
      sessionID: "s1",
      reason: "auto",
      model: { id: "model-x", providerID: "example" },
      native: false,
      text: "summary of the conversation",
      cost: 0.02,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 10, write: 0 } },
    }),
  )
  await settle()

  const compaction = spans.find((span) => span.name === "compaction")
  assert.ok(compaction, "must emit the compaction span")
  assert.strictEqual(compaction.traceId, hash("opencode-compaction:s1:2000", 16), "deterministic trace id")
  assert.strictEqual(compaction.spanId, hash("opencode-compaction-span:s1:2000", 8), "deterministic span id")
  assert.notStrictEqual(compaction.traceId, hash("opencode-turn:s1:m1", 16), "must not attach to the turn trace")
  const attr = (name: string) => compaction.attributes.find(([key]) => key === name)?.[1]
  assert.equal(attr("gen_ai.operation.name"), "compaction")
  assert.equal(attr("gen_ai.request.model"), "model-x")
  assert.equal(attr("opencode.compaction.reason"), "auto")
  assert.equal(attr("opencode.compaction.native"), false)
  assert.equal(attr("gen_ai.usage.input_tokens"), 110, "input includes cache.read")
  assert.equal(attr("gen_ai.usage.output_tokens"), 50)
  assert.equal(attr("llm.token_count.total"), 160)
  assert.equal(attr("opencode.cost.usd"), 0.02)
  assert.equal(attr("output.value"), "summary of the conversation", "summary lands in output.value")
  assert.equal(attr("openinference.span.kind"), "LLM")
  assert.equal(compaction.status.code, 1)
})

test("compaction failed: status=2 with the error message", async () => {
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handleEvent(event("session.compaction.started", 2_000, { sessionID: "s1", reason: "manual" }))
  builder.handleEvent(
    event("session.compaction.failed", 2_500, {
      sessionID: "s1",
      reason: "manual",
      error: { type: "provider_error", message: "boom" },
      cost: 0,
      tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  )
  await settle()

  const compaction = spans.find((span) => span.name === "compaction")
  assert.ok(compaction)
  assert.equal(compaction.status.code, 2)
  assert.ok(String(compaction.status.message).includes("boom"), "error message lands in status")
})

test("compaction: assistantResponses=false keeps the summary off the span; ended without started is ignored", async () => {
  const gated = makeHarness({ gates: { ...GATES, assistantResponses: false } })
  gated.builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  gated.builder.handleEvent(event("session.compaction.started", 2_000, { sessionID: "s1", reason: "auto" }))
  gated.builder.handleEvent(
    event("session.compaction.ended", 3_000, { sessionID: "s1", reason: "auto", model: { id: "m", providerID: "p" }, text: "secret summary" }),
  )
  await settle()
  const keys = new Set(gated.spans.find((span) => span.name === "compaction")?.attributes.map(([key]) => key))
  assert.ok(!keys.has("output.value"), "summary must not land on the span when the gate is off")

  const orphan = makeHarness()
  orphan.builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  orphan.builder.handleEvent(event("session.compaction.ended", 3_000, { sessionID: "s1", reason: "auto" }))
  await settle()
  assert.ok(!orphan.spans.some((span) => span.name === "compaction"), "an ended without a started must not emit a span")
})

test("compaction: started never ended; flushAll emits a bare fallback span", async () => {
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handleEvent(event("session.compaction.started", 2_000, { sessionID: "s1", reason: "auto" }))
  await builder.flushAll()
  const compaction = spans.find((span) => span.name === "compaction")
  assert.ok(compaction, "flushAll must emit the unfinished compaction as a fallback")
  assert.equal(compaction.attributes.find(([key]) => key === "opencode.compaction.reason")?.[1], "auto")
})

// ------------------------------------------------------------------ retry (aligned with #35935)

test("retry: scheduled stamps the next attempt's chat span, exactly once", async () => {
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "q")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "gpt", providerID: "p" } }))
  builder.handleEvent(event("session.step.failed", 1_200, { sessionID: "s1", assistantMessageID: "a1", error: { type: "rate_limit", message: "429" } }))
  builder.handleEvent(
    event("session.retry.scheduled", 1_250, { sessionID: "s1", assistantMessageID: "a1", attempt: 2, at: 1_300, error: { type: "rate_limit", message: "429" } }),
  )
  builder.handleEvent(event("session.step.started", 1_300, { sessionID: "s1", assistantMessageID: "a2", model: { id: "gpt", providerID: "p" } }))
  builder.handleEvent(event("session.step.ended", 1_400, { sessionID: "s1", assistantMessageID: "a2" }))
  builder.handleEvent(event("session.step.started", 1_500, { sessionID: "s1", assistantMessageID: "a3", model: { id: "gpt", providerID: "p" } }))
  builder.handleEvent(event("session.step.ended", 1_600, { sessionID: "s1", assistantMessageID: "a3" }))
  builder.handleEvent(event("session.execution.succeeded", 1_700, { sessionID: "s1" }))
  await settle()

  const first = spans.find((span) => span.spanId === hash("opencode-chat:a1", 8))
  const second = spans.find((span) => span.spanId === hash("opencode-chat:a2", 8))
  const third = spans.find((span) => span.spanId === hash("opencode-chat:a3", 8))
  assert.ok(first && second && third)
  assert.ok(!first.attributes.some(([key]) => key === "opencode.retry.attempt"), "the failed attempt's span is already emitted, so it cannot be backfilled")
  assert.equal(second.attributes.find(([key]) => key === "opencode.retry.attempt")?.[1], 2, "the retry attempt number must land on the retry span")
  assert.ok(String(second.attributes.find(([key]) => key === "opencode.retry.error")?.[1]).includes("429"))
  assert.ok(!third.attributes.some(([key]) => key === "opencode.retry.attempt"), "the stamp is consumed once and must not leak into later spans")
})

test("retry: invalid attempt (string/missing/<=0) is silently ignored", async () => {
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "q")
  builder.handleEvent(event("session.retry.scheduled", 1_100, { sessionID: "s1", attempt: "two" }))
  builder.handleEvent(event("session.retry.scheduled", 1_110, { sessionID: "s1", attempt: 0 }))
  builder.handleEvent(event("session.retry.scheduled", 1_120, { sessionID: "s1" }))
  builder.handleEvent(event("session.step.started", 1_200, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.step.ended", 1_300, { sessionID: "s1", assistantMessageID: "a1" }))
  await settle()
  const chat = spans.find((span) => span.name === "chat unknown")
  assert.ok(chat)
  assert.ok(!chat.attributes.some(([key]) => key === "opencode.retry.attempt"), "an invalid attempt must not stamp")
})

// ------------------------------------------------------------------ contentMaxLength tri-state

test("contentMaxLength=-1: long prompt is not truncated, no original_length marker", async () => {
  const { spans, builder } = makeHarness()
  const longPrompt = "x".repeat(5000)
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", longPrompt)
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.step.ended", 1_200, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.execution.succeeded", 1_300, { sessionID: "s1" }))
  await settle()

  const root = spans.find((span) => span.spanId === hash("opencode-turn-span:s1:m1", 8))
  assert.ok(root)
  assert.equal(root.attributes.find(([key]) => key === "input.value")?.[1], longPrompt, "full value lands in the attribute")
  assert.ok(!root.attributes.some(([key]) => key === "input.value_original_length"), "no truncation means no original_length")
})

test("contentMaxLength=0: value fields omitted, only *_original_length (bytes) remains", async () => {
  const { spans, builder } = makeHarness({ contentMaxLength: 0 })
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "hello world") // 11 bytes (ASCII)
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.text.ended", 1_200, { sessionID: "s1", assistantMessageID: "a1", text: "answer" }))
  builder.handleEvent(event("session.step.ended", 1_300, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.execution.succeeded", 1_400, { sessionID: "s1" }))
  await settle()

  const root = spans.find((span) => span.spanId === hash("opencode-turn-span:s1:m1", 8))
  assert.ok(root)
  assert.ok(!root.attributes.some(([key]) => key === "input.value"), "value field must not appear")
  assert.ok(!root.attributes.some(([key]) => key === "output.value"), "output.value is omitted too")
  assert.equal(root.attributes.find(([key]) => key === "input.value_original_length")?.[1], 11, "length is preserved")
  assert.equal(root.attributes.find(([key]) => key === "output.value_original_length")?.[1], 6)
})

test("contentMaxLength=N>0: truncates to the N-byte budget with a [TRUNCATED] marker and *_original_length", async () => {
  const { spans, builder } = makeHarness({ contentMaxLength: 10 })
  const longPrompt = "a".repeat(100)
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", longPrompt)
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.step.ended", 1_200, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.execution.succeeded", 1_300, { sessionID: "s1" }))
  await settle()

  const root = spans.find((span) => span.spanId === hash("opencode-turn-span:s1:m1", 8))
  assert.ok(root)
  const inputValue = root.attributes.find(([key]) => key === "input.value")?.[1]
  assert.ok(typeof inputValue === "string" && inputValue.startsWith("a".repeat(10)), "truncated to 10 chars")
  assert.ok(String(inputValue).includes("[TRUNCATED original_length=100]"), "carries the truncated marker")
  assert.equal(root.attributes.find(([key]) => key === "input.value_original_length")?.[1], 100)
})

test("contentMaxLength is a byte budget: CJK content cuts at the character boundary inside the limit", async () => {
  // 10 CJK chars = 30 UTF-8 bytes; a 10-byte cap cuts inside the 4th char and backs up to 3 chars (9 bytes)
  const { spans, builder } = makeHarness({ contentMaxLength: 10 })
  const prompt = "一二三四五六七八九十"
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", prompt)
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.step.ended", 1_200, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.execution.succeeded", 1_300, { sessionID: "s1" }))
  await settle()

  const root = spans.find((span) => span.spanId === hash("opencode-turn-span:s1:m1", 8))
  assert.ok(root)
  const inputValue = root.attributes.find(([key]) => key === "input.value")?.[1]
  assert.ok(typeof inputValue === "string" && inputValue.startsWith("一二三"), "cut backs up to a character boundary")
  assert.ok(!String(inputValue).includes("￿"), "no U+FFFD replacement character")
  assert.ok(String(inputValue).includes("[TRUNCATED original_length=30]"), "marker reports the original size in bytes")
  assert.equal(root.attributes.find(([key]) => key === "input.value_original_length")?.[1], 30, "original_length is in bytes, not chars")
})

test("propagation: activeChatContext exposes the deterministic chat span coordinates while a step is in flight", async () => {
  const { builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "hello world")
  assert.strictEqual(builder.activeChatContext("s1"), undefined, "no step started yet — nothing to propagate")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "gpt", providerID: "p" } }))
  const ctx = builder.activeChatContext("s1")
  assert.ok(ctx, "an in-flight step must be visible")
  // The coordinates must be exactly what the chat span will later emit (deterministic contract)
  assert.strictEqual(ctx!.traceId, hash("opencode-turn:s1:m1", 16))
  assert.strictEqual(ctx!.spanId, hash("opencode-chat:a1", 8))
  assert.strictEqual(ctx!.model.providerID, "p")
  builder.handleEvent(event("session.step.ended", 1_300, { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } }))
  assert.strictEqual(builder.activeChatContext("s1"), undefined, "a finished step must not be propagated to")
})

test("propagation: sub-agent steps resolve to the child trace, not the parent's", async () => {
  const { builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "root" }))
  builder.handleEvent(event("session.created", 1_001, { sessionID: "child", parentID: "root" }))
  builder.handlePrompt("root", "m1", "task")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "root", assistantMessageID: "a1", model: { id: "gpt", providerID: "p" } }))
  builder.handleEvent(event("session.tool.input.started", 1_150, { sessionID: "root", id: "tc1", assistantMessageID: "a1", name: "task" }))
  builder.handleEvent(event("session.tool.called", 1_160, { sessionID: "root", id: "tc1", assistantMessageID: "a1", input: { sessionID: "child" } }))
  builder.handleEvent(event("session.step.started", 1_200, { sessionID: "child", assistantMessageID: "a2", model: { id: "gpt", providerID: "p" } }))
  const ctx = builder.activeChatContext("child")
  assert.ok(ctx, "the child step must be visible")
  // Child steps live in the linked trace (the tool span's trace), chat span id from the child assistant message
  assert.strictEqual(ctx!.spanId, hash("opencode-chat:a2", 8))
  assert.strictEqual(ctx!.traceId, hash("opencode-turn:root:m1", 16), "the linked trace id is the parent turn's")
})

test("propagation: activeChatContext survives a turn mid-flight (second step of the same turn)", async () => {
  const { builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "hello")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "gpt", providerID: "p" } }))
  builder.handleEvent(event("session.step.ended", 1_200, { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }))
  // Tool loop: a second step of the SAME turn starts; its propagation coordinates must point at the new chat span
  builder.handleEvent(event("session.step.started", 1_300, { sessionID: "s1", assistantMessageID: "a2", model: { id: "gpt", providerID: "p" } }))
  const ctx = builder.activeChatContext("s1")
  assert.ok(ctx)
  assert.strictEqual(ctx!.spanId, hash("opencode-chat:a2", 8), "the second step's chat span must be targeted")
  assert.strictEqual(ctx!.traceId, hash("opencode-turn:s1:m1", 16), "same turn → same trace")
})

test("metrics: step end observes input/output token usage and chat duration; tool end observes execute_tool duration", async () => {
  const observations: Array<Record<string, unknown>> = []
  const { builder } = makeHarness({ observe: (obs) => observations.push(obs as unknown as Record<string, unknown>) })
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "hello world")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "kimi-k3", providerID: "aliyun" } }))
  builder.handleEvent(event("session.tool.input.started", 1_150, { sessionID: "s1", id: "tc1", assistantMessageID: "a1", name: "grep" }))
  builder.handleEvent(event("session.tool.success", 1_200, { sessionID: "s1", id: "tc1", assistantMessageID: "a1", content: [{ type: "text", text: "hit" }] }))
  builder.handleEvent(
    event("session.step.ended", 1_300, {
      sessionID: "s1",
      assistantMessageID: "a1",
      tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 20, write: 30 } },
      cost: 0.01,
    }),
  )

  const tokenObs = observations.filter((o) => o.metric === "token")
  assert.strictEqual(tokenObs.length, 2, "one input + one output observation per step")
  const input = tokenObs.find((o) => o.tokenType === "input")
  const output = tokenObs.find((o) => o.tokenType === "output")
  assert.strictEqual(input!.value, 150, "input includes cache read+write (billable input)")
  assert.strictEqual(output!.value, 50, "output includes reasoning")
  assert.strictEqual(input!.provider, "aliyun")
  assert.strictEqual(input!.model, "kimi-k3")

  const chatDur = observations.find((o) => o.metric === "duration" && o.operation === "chat")
  assert.ok(chatDur, "chat duration must be observed")
  assert.strictEqual(typeof chatDur!.durationNano, "bigint")
  assert.ok((chatDur!.durationNano as bigint) > 0n)

  const toolDur = observations.find((o) => o.metric === "duration" && o.operation === "execute_tool")
  assert.ok(toolDur, "tool duration must be observed")
  assert.strictEqual(toolDur!.tool, "grep")
  assert.strictEqual(toolDur!.errorType, undefined, "successful tool has no error.type")
})

test("metrics: a failed step observes duration with error.type", async () => {
  const observations: Array<Record<string, unknown>> = []
  const { builder } = makeHarness({ observe: (obs) => observations.push(obs as unknown as Record<string, unknown>) })
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "hello")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "m", providerID: "p" } }))
  builder.handleEvent(event("session.step.failed", 1_200, { sessionID: "s1", assistantMessageID: "a1", error: { type: "rate_limit", message: "slow down" } }))
  const dur = observations.find((o) => o.metric === "duration" && o.operation === "chat")
  assert.strictEqual(dur!.errorType, "rate_limit")
})
