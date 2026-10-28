/**
 * Plugin public-contract tests — pattern ported from oh-my-opencode-slim src/index.test.ts:
 * - Disabled contract: with enabled=false, setup reads no ctx fields at all (verified via a throwing Proxy)
 * - unload is an idempotent finalizer: repeated calls never throw
 * - Standard reload order (unload old, then load new): the new instance becomes owner directly; no globalThis garbage left behind
 * - Hook deregistration is symmetric after unload (whatever was registered gets unregistered)
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

test("disabled contract: enabled=false reads no ctx, registers no hook, builds no pipeline", async (t) => {
  prepare(t, { enabled: false })
  const ctx = new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`disabled plugin read ctx.${String(property)}`)
      },
    },
  )
  const unload = await setup(ctx) // must not throw
  assert.strictEqual(unload, undefined, "disabled setup returns no unload")
  assert.strictEqual(pipelineGlobalValue(), undefined, "disabled setup publishes no pipeline")
})

test("unload is an idempotent finalizer: repeated calls never throw and unregister every hook", async (t) => {
  const server = await startServer((_req, res) => {
    res.statusCode = 200
    res.end()
  })
  t.after(() => server.close())
  prepare(t, { tracing: { enabled: true, endpoint: server.url } })

  const mock = makeCtx()
  const unload = await setup(mock.ctx)
  assert.ok(typeof unload === "function")
  assert.ok(mock.has("experimental.ws.send") && mock.has("http.request") && mock.has("prompt"), "all three hook kinds registered")

  await unload!()
  assert.ok(!mock.has("experimental.ws.send") && !mock.has("http.request") && !mock.has("prompt"), "all hooks unregistered after unload")
  assert.strictEqual(pipelineGlobalValue(), undefined, "globalThis pipeline cleared after unload")

  await unload!() // idempotent: the second call must not throw
  await unload!()
})

test("standard reload (unload old, then load new): the new instance becomes owner directly", async (t) => {
  const server = await startServer((_req, res) => {
    res.statusCode = 200
    res.end()
  })
  t.after(() => server.close())
  prepare(t, { tracing: { enabled: true, endpoint: server.url } })

  const first = makeCtx()
  const second = makeCtx()
  const unloadFirst = await setup(first.ctx)
  assert.strictEqual(first.feeds.length, 1, "the first instance is the owner")

  await unloadFirst!()
  assert.strictEqual(pipelineGlobalValue(), undefined, "pipeline cleared after the old owner unloads")

  const unloadSecond = await setup(second.ctx)
  t.after(async () => {
    if (unloadSecond) await unloadSecond()
  })
  assert.strictEqual(second.feeds.length, 1, "after reload the new instance is owner directly and subscribes")
  assert.notStrictEqual(pipelineGlobalValue(), undefined, "pipeline republished")
})
