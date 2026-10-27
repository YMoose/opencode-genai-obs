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
      contentMaxLength: 0,
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
