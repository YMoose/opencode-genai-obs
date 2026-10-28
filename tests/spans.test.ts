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

test("happy path：turn root + chat span，确定性 id 与哈希公式一致", async () => {
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
  assert.ok(chat, "应发出 chat span")
  assert.strictEqual(chat.spanId, hash("opencode-chat:a1", 8))
  assert.strictEqual(chat.traceId, hash("opencode-turn:s1:m1", 16))

  const root = spans.find((span) => span.spanId === hash("opencode-turn-span:s1:m1", 8))
  assert.ok(root, "应发出 turn root span")
  assert.strictEqual(root.name, "hello world")
  const output = root.attributes.find(([key]) => key === "output.value")
  assert.equal(output?.[1], "answer", "最后一答应进轮根 output.value")
})

test("Bug 3：空 prompt 的轮根名回退到 session title，而不是 '(empty)'", async () => {
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.step.ended", 1_200, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.execution.succeeded", 1_300, { sessionID: "s1" }))
  await settle()

  const root = spans.find((span) => span.spanId === hash("opencode-turn-span:s1:m1", 8))
  assert.ok(root, "应发出 turn root span")
  assert.strictEqual(root.name, "T", "空输入应回退到 getSessionInfo 的 title")
})

test("Bug 6：缺 assistantMessageID / tool id 的 malformed 事件不产生伪 id span", async () => {
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

  assert.strictEqual(spans.length, 1, "只应剩 turn root")
  const bogusChat = hash("opencode-chat:undefined", 8)
  const bogusTool = hash("opencode-tool:undefined:undefined", 8)
  for (const span of spans) {
    assert.notStrictEqual(span.spanId, bogusChat, "不得出现 'undefined' 哈希的 chat span")
    assert.notStrictEqual(span.spanId, bogusTool, "不得出现 'undefined' 哈希的 tool span")
  }
})

test("Bug 4：session.deleted 补发未收尾轮根并清空该会话状态", async () => {
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "q")
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.deleted", 1_500, { sessionID: "s1" }))
  await settle()
  const afterDelete = spans.length
  assert.strictEqual(afterDelete, 1, "删除时应补发未收尾的轮根")

  await builder.flushAll()
  assert.strictEqual(spans.length, 1, "删除后 flushAll 不应再产出该会话任何 span")
})

test("子会话多轮 execution：每轮都发容器 span（同一确定性 id）", async () => {
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
  assert.strictEqual(containers.length, 2, "两轮 execution 各发一个容器 span")
})

test("user_prompt.length：不受 userPrompts gate 影响，始终进轮根", async () => {
  const { spans, builder } = makeHarness({ gates: { ...GATES, userPrompts: false } })
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "hello world") // 11 chars
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.step.ended", 1_200, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.execution.succeeded", 1_300, { sessionID: "s1" }))
  await settle()

  const root = spans.find((span) => span.spanId === hash("opencode-turn-span:s1:m1", 8))
  assert.ok(root)
  assert.equal(root.attributes.find(([key]) => key === "opencode.user_prompt.length")?.[1], 11, "未 gate，长度仍进 attr")
  assert.ok(!root.attributes.some(([key]) => key === "input.value"), "gate 关闭时 input.value 不出现")
})

test("opencode.agent.parent_session_id：子 agent chat span 带父 session id，根会话不带", async () => {
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
  assert.ok(childChat, "应发出子 agent 的 chat span")
  assert.equal(childChat.attributes.find(([key]) => key === "opencode.agent.parent_session_id")?.[1], "s1", "子 agent chat 应带父 session id")

  const rootChat = spans.find((span) => span.spanId === hash("opencode-chat:a1", 8))
  assert.ok(rootChat, "应发出根会话的 chat span")
  assert.ok(!rootChat.attributes.some(([key]) => key === "opencode.agent.parent_session_id"), "根会话不得带 parent_session_id")
})

test("content 门：content=false 时 toolDetails/toolContent 默认关", async () => {
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
  assert.ok(tool, "应发出 tool span")
  const keys = new Set(tool.attributes.map(([key]) => key))
  assert.ok(!keys.has("gen_ai.tool.call.arguments"), "toolDetails=false 时不应带调用参数")
  assert.ok(!keys.has("gen_ai.tool.call.result"), "toolContent=false 时不应带工具结果")
})

// ------------------------------------------------------------------ compaction（#35935 对齐）

test("compaction：started→ended 独立成 trace，model/usage/cost/摘要齐备", async () => {
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
  assert.ok(compaction, "应发出 compaction span")
  assert.strictEqual(compaction.traceId, hash("opencode-compaction:s1:2000", 16), "确定性 trace id")
  assert.strictEqual(compaction.spanId, hash("opencode-compaction-span:s1:2000", 8), "确定性 span id")
  assert.notStrictEqual(compaction.traceId, hash("opencode-turn:s1:m1", 16), "不得挂进 turn trace")
  const attr = (name: string) => compaction.attributes.find(([key]) => key === name)?.[1]
  assert.equal(attr("gen_ai.operation.name"), "compaction")
  assert.equal(attr("gen_ai.request.model"), "model-x")
  assert.equal(attr("opencode.compaction.reason"), "auto")
  assert.equal(attr("opencode.compaction.native"), false)
  assert.equal(attr("gen_ai.usage.input_tokens"), 110, "input 含 cache.read")
  assert.equal(attr("gen_ai.usage.output_tokens"), 50)
  assert.equal(attr("llm.token_count.total"), 160)
  assert.equal(attr("opencode.cost.usd"), 0.02)
  assert.equal(attr("output.value"), "summary of the conversation", "摘要进 output.value")
  assert.equal(attr("openinference.span.kind"), "LLM")
  assert.equal(compaction.status.code, 1)
})

test("compaction failed：status=2 且带错误信息", async () => {
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
  assert.ok(String(compaction.status.message).includes("boom"), "错误信息进 status")
})

test("compaction：assistantResponses=false 时摘要不落 span；ended 无 started 则忽略", async () => {
  const gated = makeHarness({ gates: { ...GATES, assistantResponses: false } })
  gated.builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  gated.builder.handleEvent(event("session.compaction.started", 2_000, { sessionID: "s1", reason: "auto" }))
  gated.builder.handleEvent(
    event("session.compaction.ended", 3_000, { sessionID: "s1", reason: "auto", model: { id: "m", providerID: "p" }, text: "secret summary" }),
  )
  await settle()
  const keys = new Set(gated.spans.find((span) => span.name === "compaction")?.attributes.map(([key]) => key))
  assert.ok(!keys.has("output.value"), "门控关闭时摘要不得落 span")

  const orphan = makeHarness()
  orphan.builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  orphan.builder.handleEvent(event("session.compaction.ended", 3_000, { sessionID: "s1", reason: "auto" }))
  await settle()
  assert.ok(!orphan.spans.some((span) => span.name === "compaction"), "没有 started 的 ended 不应发 span")
})

test("compaction：started 后未结束，flushAll 兜底发出裸 span", async () => {
  const { spans, builder } = makeHarness()
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handleEvent(event("session.compaction.started", 2_000, { sessionID: "s1", reason: "auto" }))
  await builder.flushAll()
  const compaction = spans.find((span) => span.name === "compaction")
  assert.ok(compaction, "flushAll 应兜底发出未完结的 compaction")
  assert.equal(compaction.attributes.find(([key]) => key === "opencode.compaction.reason")?.[1], "auto")
})

// ------------------------------------------------------------------ retry（#35935 对齐）

test("retry：scheduled 盖章到下一次尝试的 chat span，且只盖一次", async () => {
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
  assert.ok(!first.attributes.some(([key]) => key === "opencode.retry.attempt"), "失败当次的 span 已发出，不可能回填")
  assert.equal(second.attributes.find(([key]) => key === "opencode.retry.attempt")?.[1], 2, "重试尝试号应盖在重试 span 上")
  assert.ok(String(second.attributes.find(([key]) => key === "opencode.retry.error")?.[1]).includes("429"))
  assert.ok(!third.attributes.some(([key]) => key === "opencode.retry.attempt"), "盖章一次性消费，不得泄漏到后续 span")
})

test("retry：attempt 非法（字符串/缺失/≤0）静默忽略", async () => {
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
  assert.ok(!chat.attributes.some(([key]) => key === "opencode.retry.attempt"), "非法 attempt 不得盖章")
})

// ------------------------------------------------------------------ contentMaxLength 三态

test("contentMaxLength=-1（默认）：长 prompt 不截断，无 original_length 标记", async () => {
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
  assert.equal(root.attributes.find(([key]) => key === "input.value")?.[1], longPrompt, "全量进 attr")
  assert.ok(!root.attributes.some(([key]) => key === "input.value_original_length"), "无截断则无 original_length")
})

test("contentMaxLength=0：值字段省略，仅留 *_original_length", async () => {
  const { spans, builder } = makeHarness({ contentMaxLength: 0 })
  builder.handleEvent(event("session.created", 1_000, { sessionID: "s1" }))
  builder.handlePrompt("s1", "m1", "hello world") // 11 chars
  builder.handleEvent(event("session.step.started", 1_100, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.text.ended", 1_200, { sessionID: "s1", assistantMessageID: "a1", text: "answer" }))
  builder.handleEvent(event("session.step.ended", 1_300, { sessionID: "s1", assistantMessageID: "a1" }))
  builder.handleEvent(event("session.execution.succeeded", 1_400, { sessionID: "s1" }))
  await settle()

  const root = spans.find((span) => span.spanId === hash("opencode-turn-span:s1:m1", 8))
  assert.ok(root)
  assert.ok(!root.attributes.some(([key]) => key === "input.value"), "值字段不得出现")
  assert.ok(!root.attributes.some(([key]) => key === "output.value"), "output.value 同样省略")
  assert.equal(root.attributes.find(([key]) => key === "input.value_original_length")?.[1], 11, "长度保留")
  assert.equal(root.attributes.find(([key]) => key === "output.value_original_length")?.[1], 6)
})

test("contentMaxLength=N>0：截到 N 字符，附 [TRUNCATED] 标记与 *_original_length", async () => {
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
  assert.ok(typeof inputValue === "string" && inputValue.startsWith("a".repeat(10)), "截到 10 字符")
  assert.ok(String(inputValue).includes("[TRUNCATED original_length=100]"), "含 truncated 标记")
  assert.equal(root.attributes.find(([key]) => key === "input.value_original_length")?.[1], 100)
})
