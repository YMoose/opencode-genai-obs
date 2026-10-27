/**
 * 插件公共合同测试 —— 模式移植自 oh-my-opencode-slim src/index.test.ts：
 * - 禁用合同：enabled=false 时 setup 不读取任何 ctx 字段（throwing Proxy 验证）
 * - unload 是幂等 finalizer：重复调用不抛错
 * - 标准 reload 顺序（先卸旧再载新）：新实例直接成为 owner，globalThis 不留垃圾
 * - unload 后 hook 注销对称（注册了什么就注销什么）
 */
import test from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import plugin from "../src/index.js"
import { startServer, makeCtx, snapshotEnv, restoreEnv, tempDir } from "./helpers.js"

type Setup = (ctx: unknown) => Promise<() => Promise<void> | undefined>
const setup = (plugin as unknown as { setup: Setup }).setup
const PIPELINE_KEY = "__ocgObsPipeline$"

const pipelineGlobalValue = (): unknown => (globalThis as Record<string, unknown>)[PIPELINE_KEY]

function prepare(t: { after: (fn: () => Promise<void> | void) => void }, configJson: Record<string, unknown>): string {
  const snapshot = snapshotEnv()
  t.after(() => restoreEnv(snapshot))
  const dir = tempDir("ocg-contract-")
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const configPath = join(dir, "ocg-obs.json")
  writeFileSync(configPath, JSON.stringify(configJson), "utf-8")
  process.env.OCG_OBS_CONFIG = configPath
  process.env.OPENCODE_LOG_DIR = join(dir, "logs")
  return dir
}

test("禁用合同：enabled=false 时不读取 ctx、不注册 hook、不建 pipeline", async (t) => {
  prepare(t, { enabled: false })
  const ctx = new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`disabled plugin read ctx.${String(property)}`)
      },
    },
  )
  const unload = await setup(ctx) // 不应抛错
  assert.strictEqual(unload, undefined, "禁用时 setup 不返回 unload")
  assert.strictEqual(pipelineGlobalValue(), undefined, "禁用时不发布 pipeline")
})

test("unload 是幂等 finalizer：重复调用不抛错且注销全部 hook", async (t) => {
  const server = await startServer((_req, res) => {
    res.statusCode = 200
    res.end()
  })
  t.after(() => server.close())
  prepare(t, { tracing: { enabled: true, endpoint: server.url } })

  const mock = makeCtx()
  const unload = await setup(mock.ctx)
  assert.ok(typeof unload === "function")
  assert.ok(mock.has("experimental.ws.send") && mock.has("http.request") && mock.has("prompt"), "注册三类 hook")

  await unload!()
  assert.ok(!mock.has("experimental.ws.send") && !mock.has("http.request") && !mock.has("prompt"), "unload 后 hook 全部注销")
  assert.strictEqual(pipelineGlobalValue(), undefined, "unload 后 globalThis pipeline 清空")

  await unload!() // 幂等：第二次不得抛错
  await unload!()
})

test("标准 reload（先卸旧再载新）：新实例直接成为 owner", async (t) => {
  const server = await startServer((_req, res) => {
    res.statusCode = 200
    res.end()
  })
  t.after(() => server.close())
  prepare(t, { tracing: { enabled: true, endpoint: server.url } })

  const first = makeCtx()
  const second = makeCtx()
  const unloadFirst = await setup(first.ctx)
  assert.strictEqual(first.feeds.length, 1, "首实例为 owner")

  await unloadFirst!()
  assert.strictEqual(pipelineGlobalValue(), undefined, "旧 owner 卸载后 pipeline 清空")

  const unloadSecond = await setup(second.ctx)
  t.after(async () => {
    if (unloadSecond) await unloadSecond()
  })
  assert.strictEqual(second.feeds.length, 1, "reload 后新实例直接成为 owner 并订阅")
  assert.notStrictEqual(pipelineGlobalValue(), undefined, "pipeline 重新发布")
})
