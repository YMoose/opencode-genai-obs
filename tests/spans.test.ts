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

/** `seq` mirrors the envelope's durable.seq (state-transition events only); omit it for ephemeral/no-seq variants */
const event = (type: string, created: number, data: Record<string, unknown>, seq?: number) => ({ type, created, data, seq })

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

test("Bug 29: the session cap evicts idle roots before the child, keeping sub-agent lineage intact", async () => {
  const { spans, builder } = makeHarness()
  // The link-less child (parentID only, no task-tool link) is registered FIRST, so the
  // naive oldest-first eviction would drop exactly this one when the cap trips
  builder.handleEvent(event("session.created", 1_000, { sessionID: "c1", parentID: "p1", agent: "task" }))
  // 2048 root registrations push the registry past MAX_SESSIONS (2048): one idle root
  // must be evicted instead of the child
  for (let i = 0; i < 2048; i++) {
    builder.handleEvent(event("session.created", 1_100 + i, { sessionID: `s_${i}`, agent: "build" }))
  }
  // A later round on the child must still classify as a sub-agent, not as a root
  builder.handleEvent(event("session.step.started", 9_000, { sessionID: "c1", assistantMessageID: "a1", model: { id: "m", providerID: "p" } }))
  builder.handleEvent(event("session.text.ended", 9_100, { sessionID: "c1", assistantMessageID: "a1", text: "done" }))
  builder.handleEvent(event("session.step.ended", 9_200, { sessionID: "c1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.execution.succeeded", 9_300, { sessionID: "c1" }))
  await settle()

  const chat = spans.find((span) => span.spanId === hash("opencode-chat:a1", 8))
  assert.ok(chat, "must emit the child chat span")
  assert.equal(
    chat.attributes.find(([key]) => key === "opencode.session.parent_id")?.[1],
    "p1",
    "the child's registry entry (parentID) must survive the cap eviction",
  )
  assert.ok(
    spans.some((span) => span.spanId === hash("opencode-session:c1", 8)),
    "the child round must close as an invoke_agent container span",
  )
  assert.ok(
    !spans.some((span) => span.spanId === hash("opencode-turn-span:c1:auto:9000", 8)),
    "an evicted child must not be misclassified as a root session and emit a turn root",
  )
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

test("Bug 17: duplicate compaction.started delivery must not shadow the real span with a bare flush", async () => {
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "q")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.step.ended", 1_200, { sessionID: "s1", assistantMessageID: "a1" }))
  const started = event("session.compaction.started", 2_000, { sessionID: "s1", reason: "auto" })
  builder.handleEvent(started)
  builder.handleEvent(started) // duplicate delivery: same created timestamp → same run key
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

  const compactions = spans.filter((span) => span.name === "compaction")
  assert.strictEqual(compactions.length, 1, "a redelivered started must not flush a premature bare span (identical spanId — first write wins on DO_NOTHING backends)")
  assert.equal(compactions[0].attributes.find(([key]) => key === "gen_ai.request.model")?.[1], "model-x", "the surviving span keeps the real run data")
})

test("Bug 24: a stale compaction.started/ended (durable.seq below high-water) must not bare-flush a newer open run or reopen a finished one", async () => {
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }, 0))
  // run 1 completes normally
  builder.handleEvent(event("session.compaction.started", 2_000, { sessionID: "s1", reason: "auto" }, 10))
  builder.handleEvent(
    event("session.compaction.ended", 3_000, {
      sessionID: "s1",
      reason: "auto",
      model: { id: "m1", providerID: "example" },
      native: false,
      text: "summary-1",
      cost: 0.01,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 10, write: 0 } },
    }, 11),
  )
  // stale duplicate of run 1's started arrives AFTER run 1 ended: the map is empty and
  // the high-water is 11 — it must NOT reopen the finished run
  builder.handleEvent(event("session.compaction.started", 2_000, { sessionID: "s1", reason: "auto" }, 10))
  // run 2 opens
  builder.handleEvent(event("session.compaction.started", 5_000, { sessionID: "s1", reason: "manual" }, 20))
  // another stale started from run 1 while run 2 is open: it must NOT bare-flush run 2
  // under run 2's deterministic id nor overwrite the open state with run 1's
  builder.handleEvent(event("session.compaction.started", 2_000, { sessionID: "s1", reason: "auto" }, 10))
  // stale terminal from a superseded run (seq 12 < run 2's started seq 20): it must
  // NOT pop and flush the newer open run
  builder.handleEvent(event("session.compaction.ended", 2_500, { sessionID: "s1", reason: "auto" }, 12))
  // run 2 finishes
  builder.handleEvent(
    event("session.compaction.ended", 6_000, {
      sessionID: "s1",
      reason: "manual",
      model: { id: "m2", providerID: "example" },
      native: false,
      text: "summary-2",
      cost: 0.02,
      tokens: { input: 200, output: 80, reasoning: 0, cache: { read: 0, write: 0 } },
    }, 25),
  )
  await settle()

  const compactionSpans = spans.filter((s) => s.name === "compaction")
  assert.strictEqual(compactionSpans.length, 2, "exactly the two real runs must emit (pre-fix: 4, including bare flushes from the stale started events)")
  const run2 = compactionSpans.filter((s) => s.spanId === hash("opencode-compaction-span:s1:5000", 8))
  assert.strictEqual(run2.length, 1, "run 2's span must exist exactly once")
  assert.equal(run2[0].attributes.find(([key]) => key === "gen_ai.request.model")?.[1], "m2", "run 2's span must carry the real run data, not a bare flush (pre-fix: the stale started bare-flushed run 2's deterministic id first)")
  assert.equal(run2[0].attributes.find(([key]) => key === "output.value")?.[1], "summary-2", "run 2's summary must land in output.value")
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

test("chat span emits reasoning as standard gen_ai.output.messages parts (semconv ChatMessage schema)", async () => {
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "hello")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "gpt", providerID: "p" } }))
  builder.handleEvent(event("session.reasoning.ended", 1_120, { sessionID: "s1", assistantMessageID: "a1", text: "thinking hard" }))
  builder.handleEvent(event("session.reasoning.ended", 1_130, { sessionID: "s1", assistantMessageID: "a1", text: "still thinking" }))
  builder.handleEvent(event("session.text.ended", 1_140, { sessionID: "s1", assistantMessageID: "a1", ordinal: 0, text: "the answer" }))
  builder.handleEvent(event("session.step.ended", 1_200, { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1, output: 2, reasoning: 1, cache: { read: 0, write: 0 } } }))

  const chat = spans.find((span) => span.name === "chat gpt")
  assert.ok(chat, "chat span emitted")
  const raw = chat!.attributes.find(([key]) => key === "gen_ai.output.messages")?.[1]
  assert.ok(typeof raw === "string", "output messages recorded")
  // reasoning.ended carries no ordinal, so reasoning parts precede text parts — never a fabricated interleaving
  assert.deepEqual(JSON.parse(raw as string), [
    {
      role: "assistant",
      parts: [
        { type: "reasoning", content: "thinking hard" },
        { type: "reasoning", content: "still thinking" },
        { type: "text", content: "the answer" },
      ],
    },
  ])
  // the flat mirror stays for attribute-table UIs
  assert.equal(chat!.attributes.find(([key]) => key === "opencode.reasoning")?.[1], "thinking hard\n\nstill thinking")
})

test("a reasoning-only step still records gen_ai.output.messages (thinking is model output)", async () => {
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "hello")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "gpt", providerID: "p" } }))
  builder.handleEvent(event("session.reasoning.ended", 1_120, { sessionID: "s1", assistantMessageID: "a1", text: "deciding which tool to call" }))
  builder.handleEvent(event("session.step.ended", 1_200, { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1, output: 1, reasoning: 3, cache: { read: 0, write: 0 } } }))

  const chat = spans.find((span) => span.name === "chat gpt")
  assert.ok(chat, "chat span emitted")
  const raw = chat!.attributes.find(([key]) => key === "gen_ai.output.messages")?.[1]
  assert.ok(typeof raw === "string", "reasoning alone is output — messages must still be recorded")
  assert.deepEqual(JSON.parse(raw as string), [{ role: "assistant", parts: [{ type: "reasoning", content: "deciding which tool to call" }] }])
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

test("log events: user at turn open, choice at step end, tool at tool success; gated content is undefined", async () => {
  const logEvents: Array<Record<string, unknown>> = []
  const { builder } = makeHarness({
    emitLogEvent: (obs) => logEvents.push(obs as unknown as Record<string, unknown>),
    gates: { userPrompts: true, assistantResponses: false, toolDetails: true, toolContent: false, wireBody: true },
  })
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "hello world")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "kimi-k3", providerID: "aliyun" } }))
  builder.handleEvent(event("session.tool.input.started", 1_150, { sessionID: "s1", id: "tc1", assistantMessageID: "a1", name: "grep" }))
  builder.handleEvent(event("session.tool.success", 1_200, { sessionID: "s1", id: "tc1", assistantMessageID: "a1", content: [{ type: "text", text: "hit" }] }))
  builder.handleEvent(
    event("session.step.ended", 1_300, {
      sessionID: "s1",
      assistantMessageID: "a1",
      tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    }),
  )

  const user = logEvents.find((e) => e.event === "user")
  assert.ok(user, "user event at turn open")
  assert.strictEqual(user!.content, "hello world", "userPrompts gate on → content present")

  const choice = logEvents.find((e) => e.event === "choice")
  assert.ok(choice, "choice event at step end")
  assert.strictEqual(choice!.finishReason, "stop")
  assert.strictEqual(choice!.content, undefined, "assistantResponses gate off → metadata-only")
  assert.strictEqual(choice!.provider, "aliyun")

  const tool = logEvents.find((e) => e.event === "tool")
  assert.ok(tool, "tool event at tool success")
  assert.strictEqual(tool!.tool, "grep")
  assert.strictEqual(tool!.content, undefined, "toolContent gate off → metadata-only")

  // Every observation carries the deterministic span coordinates of its origin span
  assert.strictEqual(user!.traceId, hash("opencode-turn:s1:m1", 16))
  assert.strictEqual(choice!.spanId, hash("opencode-chat:a1", 8))
})

test("log events: system event fires only when a wire frame is consumed", async () => {
  const logEvents: Array<Record<string, unknown>> = []
  const { builder } = makeHarness({
    emitLogEvent: (obs) => logEvents.push(obs as unknown as Record<string, unknown>),
    consumeWire: () => ({ frame: JSON.stringify({ messages: [{ role: "system", content: "sys" }] }), seq: 1 }),
  })
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "hi")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "m", providerID: "p" } }))
  builder.handleEvent(event("session.step.ended", 1_200, { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }))
  const system = logEvents.find((e) => e.event === "system")
  assert.ok(system, "wire frame present → system event")
  assert.strictEqual(system!.gated, false)
})

test("Bug 13: duplicate step.ended delivery (opencode V2 multi-instance fan-out) must not double-emit span/metrics/logs", async () => {
  const observations: Array<Record<string, unknown>> = []
  const logEvents: Array<Record<string, unknown>> = []
  const { spans, builder } = makeHarness({
    observe: (obs) => observations.push(obs as unknown as Record<string, unknown>),
    emitLogEvent: (obs) => logEvents.push(obs as unknown as Record<string, unknown>),
  })
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "hello")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "m", providerID: "p" } }))
  const ended = event("session.step.ended", 1_200, {
    sessionID: "s1",
    assistantMessageID: "a1",
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  })
  builder.handleEvent(ended)
  builder.handleEvent(ended) // duplicate delivery of the same event (V2 fan-out)

  assert.strictEqual(spans.filter((s) => s.name === "chat m").length, 1, "duplicate step.ended must not emit a second chat span")
  assert.strictEqual(observations.filter((o) => o.metric === "token").length, 2, "duplicate step.ended must not double-count token metrics")
  assert.strictEqual(observations.filter((o) => o.metric === "duration").length, 1, "duplicate step.ended must not double-count duration")
  assert.strictEqual(logEvents.filter((e) => e.event === "choice").length, 1, "duplicate step.ended must not emit a second choice event")
})

test("Bug 16: duplicate tool terminal delivery must not emit a degraded span, double the tool log, or inflate turn counts", async () => {
  const logEvents: Array<Record<string, unknown>> = []
  const { spans, builder } = makeHarness({ emitLogEvent: (obs) => logEvents.push(obs as unknown as Record<string, unknown>) })
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "hello")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "m", providerID: "p" } }))
  builder.handleEvent(event("session.tool.input.started", 1_150, { sessionID: "s1", id: "tc1", assistantMessageID: "a1", name: "grep" }))
  const success = event("session.tool.success", 1_200, { sessionID: "s1", id: "tc1", assistantMessageID: "a1", content: [{ type: "text", text: "hit" }] })
  builder.handleEvent(success)
  builder.handleEvent(success) // duplicate delivery of the same terminal event (V2 fan-out)
  builder.handleEvent(event("session.step.ended", 1_300, { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }))
  builder.handleEvent(event("session.execution.succeeded", 1_400, { sessionID: "s1" }))
  await settle()

  const toolSpans = spans.filter((s) => s.name.startsWith("execute_tool"))
  assert.strictEqual(toolSpans.length, 1, "duplicate tool.success must not emit a second (degraded 'unknown') span")
  assert.strictEqual(toolSpans[0].name, "execute_tool grep", "the surviving span keeps the recorded name, not the degraded fallback")
  assert.strictEqual(logEvents.filter((e) => e.event === "tool").length, 1, "duplicate tool.success must not double the tool message log event (log record ids are SDK-generated — not backend-dedupable)")
  const root = spans.find((s) => s.spanId === hash("opencode-turn-span:s1:m1", 8))
  assert.ok(root, "turn root flushed")
  assert.equal(root.attributes.find(([key]) => key === "opencode.turn.messages")?.[1], 2, "chat + one tool — the duplicate must not inflate the count")
})

test("Bug 19: an interrupted step must not leak its propagation coordinates into the next turn", async () => {
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "hello")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "m", providerID: "p" } }))
  builder.handleEvent(event("session.execution.interrupted", 1_150, { sessionID: "s1", reason: "aborted" }))
  assert.strictEqual(builder.activeChatContext("s1"), undefined, "no propagation coordinates right after the interrupt")

  // next turn: the stale a1 step must not win the coordinates race (insertion order)
  builder.handlePrompt("s1", "m2", "again")
  builder.handleEvent(event("session.step.started", 1_300, { sessionID: "s1", assistantMessageID: "a2", model: { id: "m", providerID: "p" } }))
  const ctx = builder.activeChatContext("s1")
  assert.ok(ctx, "the new step advertises coordinates")
  assert.strictEqual(ctx.spanId, hash("opencode-chat:a2", 8), "coordinates point at the new chat span, not the interrupted a1 (phantom traceparent)")
  assert.strictEqual(ctx.traceId, hash("opencode-turn:s1:m2", 16), "under the new turn's trace")

  // a late step.ended for the interrupted step still emits its chat span (no data loss)
  builder.handleEvent(event("session.step.ended", 1_350, { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }))
  await settle()
  assert.strictEqual(spans.filter((s) => s.spanId === hash("opencode-chat:a1", 8)).length, 1, "the interrupted step keeps its chat span on late step.ended")
})

test("Bug 23: a late terminal from a superseded round (durable.seq below the open round) must not flush the current turn", async () => {
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }, 0))
  builder.handlePrompt("s1", "m1", "hello")
  // round 1 opens turn m1
  builder.handleEvent(event("session.execution.started", 1_050, { sessionID: "s1" }, 2))
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "m", providerID: "p" } }, 5))
  // round 1's terminal is missed/delayed; the user takes over with a new prompt
  builder.handlePrompt("s1", "m2", "again")
  // round 2 opens turn m2 (takeover flush of m1's turn — existing behavior)
  builder.handleEvent(event("session.execution.started", 1_500, { sessionID: "s1" }, 14))
  builder.handleEvent(event("session.step.started", 1_600, { sessionID: "s1", assistantMessageID: "a2", model: { id: "m", providerID: "p" } }, 16))
  // round 1's terminal arrives NOW (late delivery): its seq (12) predates round 2's
  // opening events, so it belongs to a superseded round — it must not flush m2's
  // turn nor purge round 2's in-flight step
  builder.handleEvent(event("session.execution.succeeded", 1_200, { sessionID: "s1" }, 12))
  builder.handleEvent(
    event("session.step.ended", 2_000, { sessionID: "s1", assistantMessageID: "a2", tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } }, 20),
  )
  builder.handleEvent(event("session.execution.succeeded", 2_100, { sessionID: "s1" }, 21))
  await settle()

  const chat = spans.find((s) => s.spanId === hash("opencode-chat:a2", 8))
  assert.ok(chat, "the current round's chat span must survive the stale terminal (used to be dropped after the wrongful flush purged the turn)")

  const root = spans.find((s) => s.spanId === hash("opencode-turn-span:s1:m2", 8))
  assert.ok(root, "the current turn root must be emitted")
  assert.strictEqual(root.status.code, 1, "the turn must close OK under its own round's terminal, not be flushed early by the stale one")
  assert.equal(root.attributes.find(([key]) => key === "opencode.turn.messages")?.[1], 1, "the chat span must count on the turn root")
  assert.strictEqual(root.endTimeUnixNano, 2_100_000_000n, "the turn must end at round 2's terminal (2_100ms), not at the stale terminal's degraded early flush")
})

test("Bug 23 fallback: without durable.seq a late terminal still flushes the new turn early (pre-Bug-23 behavior)", async () => {
  // Fallback = pre-Bug-23 behavior: when the envelope carries no durable.seq
  // (ephemeral variants, older hosts) the upstream contract offers no round
  // discriminator, so the stale terminal wins: the new turn is flushed early and
  // its chat span is lost. Pins the degrade path — must pass before AND after the fix.
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "hello")
  builder.handleEvent(event("session.execution.started", 1_050, { sessionID: "s1" }))
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "m", providerID: "p" } }))
  builder.handlePrompt("s1", "m2", "again")
  builder.handleEvent(event("session.execution.started", 1_500, { sessionID: "s1" }))
  builder.handleEvent(event("session.step.started", 1_600, { sessionID: "s1", assistantMessageID: "a2", model: { id: "m", providerID: "p" } }))
  builder.handleEvent(event("session.execution.succeeded", 1_200, { sessionID: "s1" })) // late old-round terminal, no seq
  builder.handleEvent(
    event("session.step.ended", 2_000, { sessionID: "s1", assistantMessageID: "a2", tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } }),
  )
  builder.handleEvent(event("session.execution.succeeded", 2_100, { sessionID: "s1" }))
  await settle()

  const root = spans.find((s) => s.spanId === hash("opencode-turn-span:s1:m2", 8))
  assert.ok(root, "the turn root is still emitted (early, by the stale terminal)")
  assert.strictEqual(root.status.code, 1, "a late succeeded carries no error object — the early flush closes OK, merely degraded")
  assert.strictEqual(root.endTimeUnixNano, 1_600_000_000n, "degraded end time: the stale flush predates the turn's own lastEndNano")
  assert.ok(!spans.some((s) => s.spanId === hash("opencode-chat:a2", 8)), "the new round's chat span is dropped — no seq, no discriminator (documented data loss)")
})

test("text.ended: out-of-order ordinals are reassembled in ordinal order on the chat span", async () => {
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "q")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "gpt", providerID: "p" } }))
  // Deliver segments out of order (ordinal 1 before ordinal 0), as the protocol permits
  builder.handleEvent(event("session.text.ended", 1_200, { sessionID: "s1", assistantMessageID: "a1", ordinal: 1, text: "world" }))
  builder.handleEvent(event("session.text.ended", 1_210, { sessionID: "s1", assistantMessageID: "a1", ordinal: 0, text: "hello" }))
  builder.handleEvent(event("session.step.ended", 1_300, { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } }))
  const chat = spans.find((span) => span.name === "chat gpt")
  assert.ok(chat)
  assert.strictEqual(chat.attributes.find(([k]) => k === "output.value")?.[1], "hello\n\nworld", "segments must be reassembled by ordinal, not arrival order")
})

test("tool span timing: starts at input.started (end-to-end audit view), not tool.called", async () => {
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "q")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "gpt", providerID: "p" } }))
  // Slow argument streaming: input.started at 1_200, called at 5_000, success at 5_300
  builder.handleEvent(event("session.tool.input.started", 1_200, { sessionID: "s1", id: "tc1", assistantMessageID: "a1", name: "read" }))
  builder.handleEvent(event("session.tool.called", 5_000, { sessionID: "s1", assistantMessageID: "a1", id: "tc1", input: {} }))
  builder.handleEvent(event("session.tool.success", 5_300, { sessionID: "s1", assistantMessageID: "a1", id: "tc1", content: [{ type: "text", text: "ok" }] }))
  const tool = spans.find((span) => span.name === "execute_tool read")
  assert.ok(tool)
  // Audit semantics: the span covers LLM argument generation + execution (unlike
  // opencode-plugin-otel, which starts at tool.called to measure pure execution).
  assert.strictEqual(tool.startTimeUnixNano, 1_200_000_000n, "tool span starts at input.started")
  assert.strictEqual(tool.endTimeUnixNano, 5_300_000_000n)
})

// ------------------------------------------------------------------ Bug 25 (synthetic wakeups)

/**
 * Shared assertion block for a wakeup round: the turn root must exist under the
 * auto-identity, carry the real wakeup text, and carry NO user attribution.
 */
async function assertWakeupRound(
  harness: Harness,
  logEvents: Array<Record<string, unknown>>,
  expectedText: string,
): Promise<void> {
  await settle()
  const root = harness.spans.find((span) => span.spanId === hash("opencode-turn-span:s1:auto:1100", 8))
  assert.ok(root, "must emit the auto turn root")
  assert.equal(
    root.attributes.find(([key]) => key === "opencode.turn.wakeup")?.[1],
    "synthetic",
    "the turn root must carry the wakeup origin",
  )
  assert.equal(root.attributes.find(([key]) => key === "input.value")?.[1], expectedText, "the real wakeup text must land in input.value")
  assert.ok(
    !root.attributes.some(([key]) => key === "opencode.user_prompt.length"),
    "a synthetic round is not a user prompt — no length attribute",
  )
  assert.strictEqual(root.name, expectedText, "the name previews the wakeup text")
  assert.ok(
    !logEvents.some((e) => e.event === "user"),
    "a synthetic wakeup must never be attributed to the user (no gen_ai.user.message)",
  )
}

test("Bug 25a: synthetic wakeup (session.inbox.enqueued synthetic item) opens a turn with the real text, no fabricated user attribution", async () => {
  const logEvents: Array<Record<string, unknown>> = []
  const harness = makeHarness({ emitLogEvent: (obs) => logEvents.push(obs as unknown as Record<string, unknown>) })
  harness.builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }, 0))
  // subagent-completion wakeup: a synthetic inbox item enqueued without any prompt hook
  harness.builder.handleEvent(
    event("session.inbox.enqueued", 1_050, { sessionID: "s1", item: { type: "synthetic", payload: { text: "subagent finished: report ready", description: "wake" } } }, 5),
  )
  harness.builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "m", providerID: "p" } }, 6))
  harness.builder.handleEvent(event("session.step.ended", 1_200, { sessionID: "s1", assistantMessageID: "a1" }, 7))
  harness.builder.handleEvent(event("session.execution.succeeded", 1_300, { sessionID: "s1" }, 8))
  await assertWakeupRound(harness, logEvents, "subagent finished: report ready")
})

test("Bug 25b: unknown-origin round (cold attach, no wakeup event) keeps graceful empty behavior with no user attribution", async () => {
  const logEvents: Array<Record<string, unknown>> = []
  const harness = makeHarness({ emitLogEvent: (obs) => logEvents.push(obs as unknown as Record<string, unknown>) })
  harness.builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  harness.builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "m", providerID: "p" } }))
  harness.builder.handleEvent(event("session.step.ended", 1_200, { sessionID: "s1", assistantMessageID: "a1" }))
  harness.builder.handleEvent(event("session.execution.succeeded", 1_300, { sessionID: "s1" }))
  await settle()

  const root = harness.spans.find((span) => span.spanId === hash("opencode-turn-span:s1:auto:1100", 8))
  assert.ok(root, "must emit the auto turn root")
  assert.equal(
    root.attributes.find(([key]) => key === "opencode.turn.wakeup")?.[1],
    "unknown",
    "a round with neither prompt nor wakeup must be marked unknown",
  )
  assert.ok(!logEvents.some((e) => e.event === "user"), "no stashed prompt and no wakeup — no gen_ai.user.message may be fabricated")
  assert.ok(
    !root.attributes.some(([key]) => key === "opencode.user_prompt.length"),
    "the fake length-6 signal (\"(auto)\" bytes) must be gone",
  )
  assert.ok(!root.attributes.some(([key]) => key === "input.value"), "nothing to attribute — no input.value")
  // Bug 3 chain: empty input falls back to the session title
  assert.strictEqual(root.name, "T", "empty input must fall back to the session title")
})

test("Bug 25c: session.synthetic event stashes the wakeup text for the same round", async () => {
  const logEvents: Array<Record<string, unknown>> = []
  const harness = makeHarness({ emitLogEvent: (obs) => logEvents.push(obs as unknown as Record<string, unknown>) })
  harness.builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }, 0))
  harness.builder.handleEvent(event("session.synthetic", 1_050, { sessionID: "s1", text: "subagent finished: report ready" }, 5))
  harness.builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "m", providerID: "p" } }, 6))
  harness.builder.handleEvent(event("session.step.ended", 1_200, { sessionID: "s1", assistantMessageID: "a1" }, 7))
  harness.builder.handleEvent(event("session.execution.succeeded", 1_300, { sessionID: "s1" }, 8))
  await assertWakeupRound(harness, logEvents, "subagent finished: report ready")
})

test("Bug 25 regression: a normal user round keeps the real user message, prompt length, and no wakeup attribute", async () => {
  const logEvents: Array<Record<string, unknown>> = []
  const harness = makeHarness({ emitLogEvent: (obs) => logEvents.push(obs as unknown as Record<string, unknown>) })
  harness.builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  harness.builder.handlePrompt("s1", "m1", "hello world")
  harness.builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "m", providerID: "p" } }))
  harness.builder.handleEvent(event("session.step.ended", 1_200, { sessionID: "s1", assistantMessageID: "a1" }))
  harness.builder.handleEvent(event("session.execution.succeeded", 1_300, { sessionID: "s1" }))
  await settle()

  const root = harness.spans.find((span) => span.spanId === hash("opencode-turn-span:s1:m1", 8))
  assert.ok(root, "must emit the user turn root")
  const user = logEvents.find((e) => e.event === "user")
  assert.ok(user, "a real user prompt must still emit gen_ai.user.message")
  assert.strictEqual(user!.content, "hello world")
  assert.equal(root.attributes.find(([key]) => key === "opencode.user_prompt.length")?.[1], 11, "the real prompt length must survive")
  assert.ok(!root.attributes.some(([key]) => key === "opencode.turn.wakeup"), "user rounds carry no wakeup attribute")
})

test("Bug 26: a mid-turn synthetic continuation (stream continuation) must not label the NEXT round", async () => {
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "hello world")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "m", providerID: "p" } }))
  // Mid-turn continuation (llm.ts:309,340): session.synthetic fires WHILE the turn is
  // open — that text belongs to THIS round, never to the next one
  builder.handleEvent(event("session.synthetic", 1_200, { sessionID: "s1", text: "continuing after stream break" }))
  builder.handleEvent(event("session.step.ended", 1_300, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.execution.succeeded", 1_400, { sessionID: "s1" }))
  // Cold attach: the next round opens with no prompt hook and no new wakeup event —
  // the lingering mid-turn wake must not be consumed for it
  builder.handleEvent(event("session.step.started", 2_100, { sessionID: "s1", assistantMessageID: "a2", model: { id: "m", providerID: "p" } }))
  builder.handleEvent(event("session.step.ended", 2_200, { sessionID: "s1", assistantMessageID: "a2" }))
  builder.handleEvent(event("session.execution.succeeded", 2_300, { sessionID: "s1" }))
  await settle()

  const first = spans.find((span) => span.spanId === hash("opencode-turn-span:s1:m1", 8))
  assert.ok(first, "the user round's turn root must still emit")
  const second = spans.find((span) => span.spanId === hash("opencode-turn-span:s1:auto:2100", 8))
  assert.ok(second, "must emit the second turn root")
  assert.equal(
    second.attributes.find(([key]) => key === "opencode.turn.wakeup")?.[1],
    "unknown",
    "the stale mid-turn continuation wake must not label the next round (pre-fix: 'synthetic')",
  )
  assert.ok(
    !second.attributes.some(([key]) => key === "input.value"),
    "the previous round's continuation text must not leak into the next round's input.value",
  )
})

test("Bug 30: execution.interrupted surfaces the host's reason enum as a queryable span attribute", async () => {
  // Upstream (v2 schema, session-event.ts): execution.interrupted carries
  // reason ∈ ["user", "shutdown", "superseded", "inactivity"] — the host already
  // distinguishes manual cancel from host kill; we just surface it (was: only
  // folded into the freeform status message, indistinguishable downstream).
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "hello")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "m", providerID: "p" } }))
  builder.handleEvent(event("session.execution.interrupted", 1_150, { sessionID: "s1", reason: "shutdown" }))
  await settle()

  const root = spans.find((span) => span.spanId === hash("opencode-turn-span:s1:m1", 8))
  assert.ok(root, "the interrupted turn root flushes")
  assert.strictEqual(
    root.attributes.find(([key]) => key === "opencode.interrupt.reason")?.[1],
    "shutdown",
    "the host reason enum lands as its own attribute — not buried in the status message",
  )
  assert.ok(
    root.status && root.status.code === 2 && root.status.message!.includes("shutdown"),
    "the status message keeps carrying the reason (back-compat)",
  )
})

test("Bug 30: a clean turn never carries an interrupt reason", async () => {
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "hello")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "m", providerID: "p" } }))
  builder.handleEvent(event("session.step.ended", 1_200, { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }))
  builder.handleEvent(event("session.execution.succeeded", 1_300, { sessionID: "s1" }))
  await settle()

  const root = spans.find((span) => span.spanId === hash("opencode-turn-span:s1:m1", 8))
  assert.ok(root, "the clean turn root flushes")
  assert.ok(
    !root.attributes.some(([key]) => key === "opencode.interrupt.reason"),
    "no interrupt reason on a turn that ended cleanly",
  )
})

test("Bug 31: unload flushAll reports in-flight work as interrupted, not OK", async () => {
  // Pre-fix, unload teardown marked every still-running turn/container OK (code 1) —
  // false success on the ledger. teardown flush must say interrupted: plugin_unload.
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "hello")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "m", providerID: "p" } }))
  // mid-flight: no step.ended, no execution.* terminal
  await builder.flushAll()

  const root = spans.find((span) => span.spanId === hash("opencode-turn-span:s1:m1", 8))
  assert.ok(root, "the in-flight turn root must flush at unload")
  assert.strictEqual(root.status.code, 2, "an interrupted-at-unload turn must not report OK")
  assert.ok(
    root.status.message!.includes("interrupted: plugin_unload"),
    "the status names the teardown cause so it is queryable and distinct from a real user cancel",
  )
})

test("Bug 31: a completed turn stays OK when flushAll runs later", async () => {
  // unload teardown must not rewrite already-closed rounds (they were never in flight)
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "hello")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "m", providerID: "p" } }))
  builder.handleEvent(event("session.step.ended", 1_200, { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }))
  builder.handleEvent(event("session.execution.succeeded", 1_300, { sessionID: "s1" }))
  await settle()
  await builder.flushAll()

  const root = spans.find((span) => span.spanId === hash("opencode-turn-span:s1:m1", 8))
  assert.ok(root, "the turn root flushes")
  assert.strictEqual(root.status.code, 1, "a turn that completed before unload stays OK")
})

// ------------------------------------------------- Bug 32 (late / unload-race tool terminals)

test("Bug 32: a tool terminal arriving after execution.interrupted still emits with its original name, duration, and Round 1 traceId", async () => {
  // Pre-fix, the interrupted round's flush deleted the open turn (the tool's trace
  // source) and purgeInFlight dropped the tool state: the late terminal found
  // neither, so its span vanished entirely.
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "hello")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "m", providerID: "p" } }))
  builder.handleEvent(event("session.tool.input.started", 1_150, { sessionID: "s1", assistantMessageID: "a1", id: "t1", name: "read" }))
  // host kill / user cancel sweeps the round while the tool is still in flight
  builder.handleEvent(event("session.execution.interrupted", 1_300, { sessionID: "s1", reason: "shutdown" }))
  // the tool terminal arrives after the round closed (settlement sweep / redelivery)
  builder.handleEvent(
    event("session.tool.failed", 1_350, {
      sessionID: "s1",
      assistantMessageID: "a1",
      id: "t1",
      error: { type: "interrupted", message: "Tool execution interrupted (sessionID: s1)" },
    }),
  )
  await settle()

  const tool = spans.find((span) => span.spanId === hash("opencode-tool:a1:t1", 8))
  assert.ok(tool, "the late tool terminal must still emit its span (pre-fix: no trace source left, dropped)")
  assert.strictEqual(tool.name, "execute_tool read", "the recorded name must survive the round close (pre-fix: 'unknown' from purged state)")
  assert.strictEqual(tool.traceId, hash("opencode-turn:s1:m1", 16), "the tool stays on its own round's trace, not on whatever is open now")
  assert.strictEqual(tool.startTimeUnixNano, 1_150_000_000n, "the tool's real start (input.started) must be preserved")
  assert.strictEqual(tool.endTimeUnixNano, 1_350_000_000n, "the tool's duration reflects its own terminal, not the round's")
  assert.strictEqual(tool.status.code, 2, "a failed tool terminal keeps its error status")
})

test("Bug 32: a late Round 1 tool terminal arriving after Round 2 started attaches to Round 1's traceId and does not inflate Round 2's opencode.turn.messages", async () => {
  // Pre-fix, the purged tool state made the late terminal emit as a nameless
  // zero-duration span under whichever turn was open — Round 2 — and count on it.
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "hello")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "m", providerID: "p" } }))
  builder.handleEvent(event("session.tool.input.started", 1_150, { sessionID: "s1", assistantMessageID: "a1", id: "t1", name: "read" }))
  builder.handleEvent(event("session.execution.interrupted", 1_300, { sessionID: "s1", reason: "user" }))
  // Round 2 takes over with a fresh prompt while Round 1's tool has not settled
  builder.handlePrompt("s1", "m2", "again")
  builder.handleEvent(event("session.step.started", 2_100, { sessionID: "s1", assistantMessageID: "a2", model: { id: "m", providerID: "p" } }))
  // Round 1's tool terminal arrives NOW, after Round 2 opened
  builder.handleEvent(
    event("session.tool.failed", 2_150, {
      sessionID: "s1",
      assistantMessageID: "a1",
      id: "t1",
      error: { type: "interrupted", message: "Tool execution interrupted (sessionID: s1)" },
    }),
  )
  builder.handleEvent(
    event("session.step.ended", 2_200, {
      sessionID: "s1",
      assistantMessageID: "a2",
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  )
  builder.handleEvent(event("session.execution.succeeded", 2_300, { sessionID: "s1" }))
  await settle()

  const tool = spans.find((span) => span.spanId === hash("opencode-tool:a1:t1", 8))
  assert.ok(tool, "the late Round 1 tool terminal must emit")
  assert.strictEqual(tool.traceId, hash("opencode-turn:s1:m1", 16), "attribution stays on Round 1's trace (pre-fix: Round 2's open turn)")
  assert.strictEqual(tool.name, "execute_tool read", "the Round 1 tool keeps its recorded name (pre-fix: 'unknown', state purged)")
  assert.strictEqual(tool.startTimeUnixNano, 1_150_000_000n, "the Round 1 tool keeps its real start time")
  const root = spans.find((span) => span.spanId === hash("opencode-turn-span:s1:m2", 8))
  assert.ok(root, "Round 2's turn root must emit")
  assert.equal(
    root.attributes.find(([key]) => key === "opencode.turn.messages")?.[1],
    1,
    "Round 2 counts its own chat span only — the late Round 1 tool must not inflate it (pre-fix: 2)",
  )
  assert.strictEqual(root.endTimeUnixNano, 2_300_000_000n, "Round 2's end time stays at its own terminal")
})

test("Bug 32: unload flushAll emits in-flight tools as interrupted: plugin_unload instead of silently dropping them", async () => {
  // The measured unload race (host restart): the SSE pump stops at dispose before
  // the host's final settlement sweep delivers the tool terminals, so flushAll is
  // the only place those tools can still emit — pre-fix they were silently dropped.
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "hello")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "m", providerID: "p" } }))
  builder.handleEvent(event("session.tool.input.started", 1_150, { sessionID: "s1", assistantMessageID: "a1", id: "t1", name: "read" }))
  builder.handleEvent(event("session.tool.called", 1_160, { sessionID: "s1", assistantMessageID: "a1", id: "t1", input: { path: "src/" } }))
  // unload mid-tool: no tool terminal, no round terminal
  await builder.flushAll()

  const tool = spans.find((span) => span.spanId === hash("opencode-tool:a1:t1", 8))
  assert.ok(tool, "the in-flight tool must emit at unload (pre-fix: silently dropped)")
  assert.strictEqual(tool.name, "execute_tool read", "the recorded name survives teardown")
  assert.strictEqual(tool.traceId, hash("opencode-turn:s1:m1", 16), "the tool lands on its round's trace")
  assert.strictEqual(tool.startTimeUnixNano, 1_150_000_000n, "the real start time survives teardown")
  assert.strictEqual(tool.status.code, 2, "an interrupted-at-unload tool must not report OK")
  assert.ok(
    tool.status.message!.includes("interrupted: plugin_unload"),
    "the status names the teardown cause — queryable, distinct from a real tool error or user cancel",
  )
  const root = spans.find((span) => span.spanId === hash("opencode-turn-span:s1:m1", 8))
  assert.ok(root, "the in-flight turn root must still flush at unload")
  assert.equal(
    root.attributes.find(([key]) => key === "opencode.turn.messages")?.[1],
    1,
    "the emitted tool counts on its own turn root",
  )
})

// ------------------------------------------------- Bug 34 (teardown must not fake a host interrupt reason)

test("Bug 34: unload teardown reports interrupted status but never sets opencode.interrupt.reason", async () => {
  // User decision (option B, 2026-11-03): the attribute is owned by the host enum
  // ["user","shutdown","superseded","inactivity"] — one field, one source of meaning.
  // "plugin_unload" is a plugin-invented value; pre-fix it leaked into the attribute
  // at teardown. The unload story stays in the freeform status.message instead.
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "hello")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "m", providerID: "p" } }))
  builder.handleEvent(event("session.tool.input.started", 1_150, { sessionID: "s1", assistantMessageID: "a1", id: "t1", name: "read" }))
  // unload mid-round: no tool terminal, no execution.* terminal
  await builder.flushAll()

  const root = spans.find((span) => span.spanId === hash("opencode-turn-span:s1:m1", 8))
  assert.ok(root, "the in-flight turn root must still flush at unload")
  assert.ok(
    !root.attributes.some(([key]) => key === "opencode.interrupt.reason"),
    "teardown must not set the host-owned reason attribute (pre-fix: carried the invented 'plugin_unload')",
  )
  assert.ok(
    root.status.code === 2 && root.status.message!.includes("interrupted: plugin_unload"),
    "the unload story stays visible in the freeform status message (Bug 31 semantics unchanged)",
  )

  const tool = spans.find((span) => span.spanId === hash("opencode-tool:a1:t1", 8))
  assert.ok(tool, "the in-flight tool must still emit at unload (no Bug 32 regression)")
  assert.ok(
    !tool.attributes.some(([key]) => key === "opencode.interrupt.reason"),
    "the tool span never carries the host reason attribute",
  )
})

test("Bug 34: unload teardown of a sub-agent container does not set opencode.interrupt.reason", async () => {
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "root" }))
  builder.handleEvent(event("session.created", 1_001, { sessionID: "child", parentID: "root" }))
  builder.handlePrompt("root", "m1", "task")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "root", assistantMessageID: "a1", model: { id: "m", providerID: "p" } }))
  builder.handleEvent(event("session.tool.input.started", 1_150, { sessionID: "root", assistantMessageID: "a1", id: "tc1", name: "task" }))
  builder.handleEvent(event("session.tool.called", 1_160, { sessionID: "root", assistantMessageID: "a1", id: "tc1", input: { sessionID: "child" } }))
  builder.handleEvent(event("session.step.started", 1_200, { sessionID: "child", assistantMessageID: "a2", model: { id: "m", providerID: "p" } }))
  // unload with the child's round still open: the container flushes as interrupted
  await builder.flushAll()

  const container = spans.find((span) => span.spanId === hash("opencode-session:child", 8))
  assert.ok(container, "the in-flight sub-agent container must flush at unload")
  assert.ok(
    !container.attributes.some(([key]) => key === "opencode.interrupt.reason"),
    "teardown must not set the host-owned reason attribute on containers either",
  )
  assert.ok(
    container.status.code === 2 && container.status.message!.includes("interrupted: plugin_unload"),
    "the container still names the teardown cause in its status message",
  )
})

test("Bug 34: a real host interrupt still lands opencode.interrupt.reason on the turn root", async () => {
  // Regression guard for the host-driven path (Bug 30): stopping teardown from
  // setting the attribute must not stop the real session.execution.interrupted
  // event — the host enum value remains a queryable attribute.
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "hello")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1", model: { id: "m", providerID: "p" } }))
  builder.handleEvent(event("session.execution.interrupted", 1_150, { sessionID: "s1", reason: "user" }))
  await settle()

  const root = spans.find((span) => span.spanId === hash("opencode-turn-span:s1:m1", 8))
  assert.ok(root, "the interrupted turn root flushes")
  assert.strictEqual(
    root.attributes.find(([key]) => key === "opencode.interrupt.reason")?.[1],
    "user",
    "the host enum value keeps flowing through the attribute (host path intact)",
  )
})
