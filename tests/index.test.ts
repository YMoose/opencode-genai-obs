/**
 * index.ts 插件级集成测试（mock ctx + 假 Phoenix）：
 * - Bug 1：tracing.enabled=false 的 wire-only 配置不订阅事件流、不外发任何 HTTP，
 *          wire JSONL 照常落盘
 * - Bug 5：owner 实例卸载后，存活实例的 hook 触发 pipeline 补选，采集恢复
 */
import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import plugin from "../src/index.js"
import { startServer, waitFor, makeCtx, snapshotEnv, restoreEnv, tempDir, type MockCtx } from "./helpers.js"

type Setup = (ctx: unknown) => Promise<() => Promise<void>>

const setup = (plugin as unknown as { setup: Setup }).setup

test("Bug 1：wire-only（tracing.enabled=false）不外发任何请求，wire JSONL 照常落盘", async (t) => {
  const snapshot = snapshotEnv()
  t.after(() => restoreEnv(snapshot))
  const dir = tempDir("ocg-idx-wireonly-")
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const server = await startServer((_req, res) => {
    res.statusCode = 200
    res.end()
  })
  t.after(() => server.close())

  const configPath = join(dir, "ocg-obs.json")
  writeFileSync(
    configPath,
    JSON.stringify({
      tracing: { enabled: false, endpoint: server.url },
      wire: { enabled: true, directory: join(dir, "raw") },
    }),
    "utf-8",
  )
  process.env.OCG_OBS_CONFIG = configPath
  process.env.OPENCODE_LOG_DIR = join(dir, "logs")

  const mock = makeCtx()
  const unload = await setup(mock.ctx)
  assert.ok(typeof unload === "function", "setup 应返回 unload")

  assert.ok(!mock.has("prompt"), "tracing 关闭时不应注册 prompt hook")
  assert.strictEqual(mock.feeds.length, 0, "wire-only 不应订阅 SSE 事件流")

  mock.fire("experimental.ws.send", {
    sessionID: "s1",
    agent: "build",
    model: { providerID: "p", modelID: "m1" },
    kind: "primary",
    frame: JSON.stringify({ hello: "world" }),
  })
  await waitFor(() => existsSync(join(dir, "raw", "s1.jsonl")))
  await new Promise((resolve) => setTimeout(resolve, 100)) // 留出可能的（不该发生的）外发窗口

  const record = JSON.parse(readFileSync(join(dir, "raw", "s1.jsonl"), "utf-8").trim())
  assert.strictEqual(record.sessionID, "s1")
  assert.ok(record.frame.includes("world"), "wire body 应落盘")

  assert.strictEqual(server.requests.length, 0, "tracing 关闭时不得有任何外发 HTTP 请求")
  await unload()
})

test("Bug 5：owner 卸载后，存活实例 hook 触发补选，span 恢复外发", async (t) => {
  const snapshot = snapshotEnv()
  t.after(() => restoreEnv(snapshot))
  const dir = tempDir("ocg-idx-reelect-")
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const server = await startServer((_req, res) => {
    res.statusCode = 200
    res.end()
  })
  t.after(() => server.close())

  const configPath = join(dir, "ocg-obs.json")
  writeFileSync(
    configPath,
    JSON.stringify({ tracing: { enabled: true, endpoint: server.url, project: "t" } }),
    "utf-8",
  )
  process.env.OCG_OBS_CONFIG = configPath
  process.env.OPENCODE_LOG_DIR = join(dir, "logs")

  const a: MockCtx = makeCtx()
  const b: MockCtx = makeCtx()
  const unloadA = await setup(a.ctx)
  const unloadB = await setup(b.ctx)
  t.after(async () => {
    await unloadA()
    await unloadB()
  })

  assert.strictEqual(a.feeds.length, 1, "首个实例成为 owner 并订阅事件流")
  assert.strictEqual(b.feeds.length, 0, "第二实例为 observer，不订阅")

  // 旧 owner 卸载（热重载场景：先卸旧）→ globalThis pipeline 清空
  await unloadA()

  // B 的 hook 触发补选；补选完成后本条 prompt 会被补投递
  b.fire("prompt", { sessionID: "s1", messageID: "m1", prompt: { text: "re-elect" } })
  await waitFor(() => b.feeds.length === 1, 5_000)

  // 跑一轮完整 turn，span 应到达假 Phoenix
  const feed = b.feeds[0]!
  const now = Date.now()
  feed.push({ type: "session.created", created: now, data: { sessionID: "s1", agent: "build" } })
  feed.push({ type: "session.step.started", created: now, data: { sessionID: "s1", assistantMessageID: "a1", model: { id: "m", providerID: "p" } } })
  feed.push({ type: "session.text.ended", created: now, data: { sessionID: "s1", assistantMessageID: "a1", text: "hi" } })
  feed.push({ type: "session.step.ended", created: now, data: { sessionID: "s1", assistantMessageID: "a1" } })
  feed.push({ type: "session.execution.succeeded", created: now, data: { sessionID: "s1" } })

  await waitFor(() => server.requests.some((request) => request.path === "/v1/traces" && request.body.length > 0), 5_000)
})
