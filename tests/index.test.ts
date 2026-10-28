/**
 * index.ts plugin-level integration tests (mock ctx + fake OTLP backend):
 * - Bug 1: a wire-only config (tracing.enabled=false) subscribes to no event stream and
 *          sends no HTTP at all, while wire JSONL still lands on disk
 * - Bug 5: after the owner instance unloads, a surviving instance's hook triggers
 *          pipeline re-election and capture resumes
 * - De-platforming: annotations.enabled=false sends no backend-specific /v1/session_annotations
 */
import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import plugin from "../src/index.js"
import { startServer, waitFor, makeCtx, snapshotEnv, restoreEnv, tempDir, type MockCtx } from "./helpers.js"

type Setup = (ctx: unknown) => Promise<() => Promise<void>>

const setup = (plugin as unknown as { setup: Setup }).setup

test("Bug 1: wire-only (tracing.enabled=false) sends no outbound request while wire JSONL still lands on disk", async (t) => {
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
  assert.ok(typeof unload === "function", "setup must return unload")

  assert.ok(!mock.has("prompt"), "no prompt hook registered when tracing is off")
  assert.strictEqual(mock.feeds.length, 0, "wire-only must not subscribe to the SSE event stream")

  mock.fire("experimental.ws.send", {
    sessionID: "s1",
    agent: "build",
    model: { providerID: "p", modelID: "m1" },
    kind: "primary",
    frame: JSON.stringify({ hello: "world" }),
  })
  await waitFor(() => existsSync(join(dir, "raw", "s1.jsonl")))
  await new Promise((resolve) => setTimeout(resolve, 100)) // leave a window for any (unexpected) outbound traffic

  const record = JSON.parse(readFileSync(join(dir, "raw", "s1.jsonl"), "utf-8").trim())
  assert.strictEqual(record.sessionID, "s1")
  assert.ok(record.frame.includes("world"), "wire body must land on disk")

  assert.strictEqual(server.requests.length, 0, "no outbound HTTP request when tracing is off")
  await unload()
})

test("de-platforming: annotations.enabled=false uses only standard /v1/traces and sends no session_annotations", async (t) => {
  const snapshot = snapshotEnv()
  t.after(() => restoreEnv(snapshot))
  const dir = tempDir("ocg-idx-noannot-")
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
      tracing: { enabled: true, endpoint: server.url, project: "t", annotations: { enabled: false } },
    }),
    "utf-8",
  )
  process.env.OCG_OBS_CONFIG = configPath
  process.env.OPENCODE_LOG_DIR = join(dir, "logs")

  const mock = makeCtx()
  const unload = await setup(mock.ctx)
  t.after(() => unload?.())

  const feed = mock.feeds[0]!
  const now = Date.now()
  feed.push({ type: "session.created", created: now, data: { sessionID: "s1", agent: "build" } })
  feed.push({ type: "session.step.started", created: now, data: { sessionID: "s1", assistantMessageID: "a1", model: { id: "m", providerID: "p" } } })
  feed.push({ type: "session.step.ended", created: now, data: { sessionID: "s1", assistantMessageID: "a1" } })
  feed.push({ type: "session.execution.succeeded", created: now, data: { sessionID: "s1" } })

  await waitFor(() => server.requests.some((request) => request.path === "/v1/traces" && request.body.length > 0), 5_000)
  assert.ok(
    server.requests.every((request) => !request.path.includes("session_annotations")),
    "no backend-specific /v1/session_annotations request when annotations are off",
  )
})

test("Bug 5: after the owner unloads, a surviving instance's hook triggers re-election and spans resume", async (t) => {
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

  assert.strictEqual(a.feeds.length, 1, "the first instance becomes owner and subscribes to the event stream")
  assert.strictEqual(b.feeds.length, 0, "the second instance is an observer and does not subscribe")

  // unload the old owner (hot-reload scenario: old unloads first) → the globalThis pipeline is cleared
  await unloadA()

  // B's hook triggers re-election; once done, this prompt event is redelivered
  b.fire("prompt", { sessionID: "s1", messageID: "m1", prompt: { text: "re-elect" } })
  await waitFor(() => b.feeds.length === 1, 5_000)

  // run a full turn; spans should reach the fake backend
  const feed = b.feeds[0]!
  const now = Date.now()
  feed.push({ type: "session.created", created: now, data: { sessionID: "s1", agent: "build" } })
  feed.push({ type: "session.step.started", created: now, data: { sessionID: "s1", assistantMessageID: "a1", model: { id: "m", providerID: "p" } } })
  feed.push({ type: "session.text.ended", created: now, data: { sessionID: "s1", assistantMessageID: "a1", text: "hi" } })
  feed.push({ type: "session.step.ended", created: now, data: { sessionID: "s1", assistantMessageID: "a1" } })
  feed.push({ type: "session.execution.succeeded", created: now, data: { sessionID: "s1" } })

  await waitFor(() => server.requests.some((request) => request.path === "/v1/traces" && request.body.length > 0), 5_000)
})
