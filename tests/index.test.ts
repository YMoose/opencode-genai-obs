/**
 * index.ts plugin-level integration tests (mock ctx + fake OTLP backend):
 * - Bug 1: a wire-only config (tracing.enabled=false) subscribes to no event stream and
 *          sends no HTTP at all, while wire JSONL still lands on disk
 * - Bug 5: after the owner instance unloads, a surviving instance's hook triggers
 *          pipeline re-election and capture resumes
 * - Bug 10: sub-agent sessions (parentID set) are annotated too
 * - Bug 11: the first terminal execution event re-annotates after the spans flush
 * - Bug 12: startup backfill annotates sessions created before the plugin loaded
 * - De-platforming: annotations.enabled=false sends no backend-specific /v1/session_annotations
 */
import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { createServer as createNetServer, type AddressInfo } from "node:net"
import plugin from "../src/index.js"
import {
  startServer,
  waitFor,
  makeCtx,
  snapshotEnv,
  restoreEnv,
  tempDir,
  type MockCtx,
  type MockListInput,
  type TestServer,
} from "./helpers.js"

type Setup = (ctx: unknown) => Promise<() => Promise<void>>

const setup = (plugin as unknown as { setup: Setup }).setup

const annotationRequests = (server: TestServer) =>
  server.requests.filter((request) => request.path.includes("/v1/session_annotations"))

/** Annotation payload entries of one request (label entries only, no transport fields) */
const annotationEntries = (body: string): Array<{ session_id: string; name: string; result: { label: string } }> =>
  JSON.parse(body).data

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

  const listCalls: Array<MockListInput | undefined> = []
  const mock = makeCtx({
    sessionList: async (input) => {
      listCalls.push(input)
      return { data: [], cursor: {} }
    },
  })
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
  assert.strictEqual(listCalls.length, 0, "no startup backfill (no session.list call) when annotations are off")
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

test("Bug 10: a sub-agent session.created (parentID set) is annotated too", async (t) => {
  const snapshot = snapshotEnv()
  t.after(() => restoreEnv(snapshot))
  const dir = tempDir("ocg-idx-subagent-")
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

  const mock = makeCtx()
  const unload = await setup(mock.ctx)
  t.after(() => unload?.())

  mock.feeds[0]!.push({
    type: "session.created",
    created: Date.now(),
    data: { sessionID: "child1", parentID: "root1", title: "child task" },
  })

  await waitFor(() => annotationRequests(server).length === 1, 5_000)
  const entries = annotationEntries(annotationRequests(server)[0]!.body)
  assert.deepStrictEqual(
    entries.map((entry) => entry.session_id),
    ["child1", "child1"],
    "both annotation columns must target the sub-agent session id",
  )
  assert.ok(
    entries.some((entry) => entry.name === "title" && entry.result.label === "child task"),
    "the sub-agent title must be annotated",
  )
})

test("Bug 11: the first terminal execution event re-annotates the session after the spans flush", async (t) => {
  const snapshot = snapshotEnv()
  t.after(() => restoreEnv(snapshot))
  const dir = tempDir("ocg-idx-postspan-")
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

  const mock = makeCtx()
  const unload = await setup(mock.ctx)
  t.after(() => unload?.())

  const feed = mock.feeds[0]!
  const now = Date.now()
  feed.push({ type: "session.created", created: now, data: { sessionID: "s1", title: "early title" } })
  feed.push({ type: "session.execution.succeeded", created: now + 1, data: { sessionID: "s1" } })
  // A later terminal event in the same process must not schedule a second annotation
  feed.push({ type: "session.execution.failed", created: now + 2, data: { sessionID: "s1" } })

  // The first annotation is immediate (session.created); the second only after the spans flush
  await waitFor(() => annotationRequests(server).length >= 2, 8_000)
  await new Promise((resolve) => setTimeout(resolve, 300)) // leave a window for a third (unexpected) POST
  const requests = annotationRequests(server)
  assert.strictEqual(requests.length, 2, "one annotation from session.created plus one post-span, nothing more")
  const labels = requests.map((request) =>
    annotationEntries(request.body).find((entry) => entry.name === "title")?.result.label,
  )
  assert.deepStrictEqual(labels, ["early title", "test-title"], "the post-span annotation refreshes from session.get")
})

test("Bug 12: startup backfill annotates every existing session across list pages", async (t) => {
  const snapshot = snapshotEnv()
  t.after(() => restoreEnv(snapshot))
  const dir = tempDir("ocg-idx-backfill-")
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

  const listCalls: Array<MockListInput | undefined> = []
  const mock = makeCtx({
    sessionList: async (input) => {
      listCalls.push(input)
      if (!input?.cursor) {
        return {
          data: [
            { id: "s1", title: "one", location: { directory: "/w/a" } },
            { id: "s2", title: "two", location: { directory: "/w/b" } },
          ],
          cursor: { next: "page2" },
        }
      }
      return { data: [{ id: "s3", title: "three", location: { directory: "/w/c" } }], cursor: { next: null } }
    },
  })
  const unload = await setup(mock.ctx)
  t.after(() => unload?.())

  await waitFor(() => annotationRequests(server).length >= 3, 5_000)
  const bodies = annotationRequests(server).slice(0, 3).map((request) => annotationEntries(request.body))
  assert.deepStrictEqual(
    bodies.map((entries) => entries[0]!.session_id).sort(),
    ["s1", "s2", "s3"],
    "every session from every page must be annotated",
  )
  assert.strictEqual(listCalls.length, 2, "pagination must follow cursor.next until it is exhausted")
  assert.strictEqual(listCalls[1]!.cursor, "page2", "the next page must be requested with the returned cursor")
  const first = bodies.find((entries) => entries[0]!.session_id === "s1")!
  assert.ok(
    first.some((entry) => entry.name === "project" && entry.result.label === "a"),
    "the project label is the basename of the session directory",
  )
  assert.ok(
    first.some((entry) => entry.name === "title" && entry.result.label === "one"),
    "the backfilled title comes from the listed session",
  )
})

test("trace propagation: model.request injects traceparent only for whitelisted providers with an in-flight step", async (t) => {
  const snapshot = snapshotEnv()
  t.after(() => restoreEnv(snapshot))
  const dir = tempDir("ocg-idx-prop-")
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
      tracing: {
        enabled: true,
        endpoint: server.url,
        project: "t",
        annotations: { enabled: false },
        propagation: { providers: ["aliyun"] },
      },
    }),
    "utf-8",
  )
  process.env.OCG_OBS_CONFIG = configPath
  process.env.OPENCODE_LOG_DIR = join(dir, "logs")

  const mock = makeCtx()
  const unload = await setup(mock.ctx)
  t.after(() => unload())

  assert.ok(mock.has("model.request"), "the model.request hook must be registered when propagation is configured")

  // No step in flight → nothing to propagate
  const noStepHeaders: Record<string, string> = {}
  mock.fire("model.request", { sessionID: "s1", agent: "build", model: { providerID: "aliyun", id: "kimi-k3" }, kind: "primary", headers: noStepHeaders })
  assert.strictEqual(noStepHeaders.traceparent, undefined, "no active step → no injection")

  // A step is now in flight — feed is an async pump: wait until the builder has
  // processed step.started before firing the request
  mock.feeds[0]!.push({ type: "session.created", created: 1_000, data: { sessionID: "s1", agent: "build" } })
  mock.fire("prompt", { sessionID: "s1", messageID: "m1", prompt: { text: "hi" } })
  mock.feeds[0]!.push({ type: "session.step.started", created: 1_100, data: { sessionID: "s1", assistantMessageID: "a1", agent: "build", model: { id: "kimi-k3", providerID: "aliyun" } } })
  await new Promise((resolve) => setTimeout(resolve, 50))

  // Whitelisted provider, matching step → inject
  const headers: Record<string, string> = {}
  mock.fire("model.request", { sessionID: "s1", agent: "build", model: { providerID: "aliyun", id: "kimi-k3" }, kind: "primary", headers })
  assert.ok(headers.traceparent, "whitelisted provider with an in-flight step must be injected")
  const parts = headers.traceparent!.split("-")
  assert.strictEqual(parts.length, 4, "W3C traceparent has 4 dash-separated fields")
  assert.strictEqual(parts[0], "00")
  assert.strictEqual(parts[1]!.length, 32, "trace-id is 32 hex chars")
  assert.strictEqual(parts[2]!.length, 16, "span-id is 16 hex chars")
  assert.strictEqual(parts[3], "01", "sampled flag")

  // Non-whitelisted provider → no injection
  const otherHeaders: Record<string, string> = {}
  mock.fire("model.request", { sessionID: "s1", agent: "build", model: { providerID: "volces", id: "x" }, kind: "primary", headers: otherHeaders })
  assert.strictEqual(otherHeaders.traceparent, undefined, "non-whitelisted provider must not be injected")

  // Auxiliary request (title generation) → never injected
  const titleHeaders: Record<string, string> = {}
  mock.fire("model.request", { sessionID: "s1", agent: "build", model: { providerID: "aliyun", id: "kimi-k3" }, kind: "title", headers: titleHeaders })
  assert.strictEqual(titleHeaders.traceparent, undefined, "auxiliary requests must not be injected")

  // Mismatched model → the request is not the active step → no injection
  const mismatchHeaders: Record<string, string> = {}
  mock.fire("model.request", { sessionID: "s1", agent: "build", model: { providerID: "aliyun", id: "other-model" }, kind: "primary", headers: mismatchHeaders })
  assert.strictEqual(mismatchHeaders.traceparent, undefined, "a request that does not match the active step must not be injected")
})

test("trace propagation: the model.request hook is not registered when no providers are configured", async (t) => {
  const snapshot = snapshotEnv()
  t.after(() => restoreEnv(snapshot))
  const dir = tempDir("ocg-idx-propnil-")
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const server = await startServer((_req, res) => {
    res.statusCode = 200
    res.end()
  })
  t.after(() => server.close())

  const configPath = join(dir, "ocg-obs.json")
  writeFileSync(configPath, JSON.stringify({ tracing: { enabled: true, endpoint: server.url, annotations: { enabled: false } } }), "utf-8")
  process.env.OCG_OBS_CONFIG = configPath
  process.env.OPENCODE_LOG_DIR = join(dir, "logs")

  const mock = makeCtx()
  const unload = await setup(mock.ctx)
  t.after(() => unload())

  assert.ok(!mock.has("model.request"), "no propagation configured → no hook registration")
})

test("Bug 15: an unusable wire.directory must not fail plugin setup (degrade, hooks stay registered)", async (t) => {
  const snapshot = snapshotEnv()
  t.after(() => restoreEnv(snapshot))
  const dir = tempDir("ocg-idx-baddir-")
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // A regular file as the parent makes the recorder's mkdirSync fail with ENOTDIR
  const blocker = join(dir, "blocker")
  writeFileSync(blocker, "", "utf-8")

  const configPath = join(dir, "ocg-obs.json")
  writeFileSync(
    configPath,
    JSON.stringify({
      tracing: { enabled: false },
      wire: { enabled: true, directory: join(blocker, "raw") },
    }),
    "utf-8",
  )
  process.env.OCG_OBS_CONFIG = configPath

  const mock = makeCtx()
  const unload = await setup(mock.ctx) // used to reject: ENOTDIR escaped through elect("setup")
  t.after(() => unload())
  assert.ok(mock.has("experimental.ws.send"), "wire hooks stay registered in degraded mode")
  assert.doesNotThrow(
    () => mock.fire("experimental.ws.send", { sessionID: "s1", kind: "primary", frame: "{}" }),
    "degraded capture must not throw into the host",
  )
})

test("Bug 15: a throwing pipeline member is contained at the dispatch boundary, never thrown into the host", async (t) => {
  const snapshot = snapshotEnv()
  t.after(() => restoreEnv(snapshot))
  const dir = tempDir("ocg-idx-poison-")
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const configPath = join(dir, "ocg-obs.json")
  writeFileSync(
    configPath,
    JSON.stringify({
      tracing: { enabled: false },
      wire: { enabled: true, directory: join(dir, "raw") },
    }),
    "utf-8",
  )
  process.env.OCG_OBS_CONFIG = configPath

  const mock = makeCtx()
  const unload = await setup(mock.ctx)
  // t.after runs LIFO: global scrub first, then unload, then env restore
  t.after(() => {
    delete (globalThis as Record<string, unknown>)["__ocgObsPipeline$"]
    delete (globalThis as Record<string, unknown>)["__ocgObsPipelineGen$"]
  })
  t.after(() => unload())
  ;(globalThis as Record<string, unknown>)["__ocgObsPipeline$"] = {
    generation: 999,
    dispose: async () => {},
    recordWsSend: () => {
      throw new Error("poisoned pipeline member")
    },
    recordHttpRequest: () => {},
    handlePrompt: () => {},
    injectTraceContext: () => {},
  }
  assert.doesNotThrow(
    () => mock.fire("experimental.ws.send", { sessionID: "s1", kind: "primary", frame: "{}" }),
    "the dispatch boundary must contain a throwing deliver",
  )
})

test("wire-only mode never runs the startup probe; tracing mode probes once per distinct endpoint", async (t) => {
  const snapshot = snapshotEnv()
  t.after(() => restoreEnv(snapshot))
  const dir = tempDir("ocg-idx-probe-")
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  let connections = 0
  const netServer = createNetServer(() => { connections += 1 })
  await new Promise<void>((resolve) => netServer.listen(0, "127.0.0.1", resolve))
  const { port } = netServer.address() as AddressInfo
  t.after(() => new Promise<void>((resolve) => netServer.close(() => resolve())))

  const writeConfig = (tracingEnabled: boolean) => {
    const configPath = join(dir, `cfg-${tracingEnabled ? "on" : "off"}.json`)
    writeFileSync(
      configPath,
      JSON.stringify({
        tracing: { enabled: tracingEnabled, endpoint: `http://127.0.0.1:${port}` },
        wire: { enabled: true, directory: join(dir, "raw") },
      }),
      "utf-8",
    )
    process.env.OCG_OBS_CONFIG = configPath
  }

  // Wire-only: nothing may leave the process — the probe must not even connect
  writeConfig(false)
  const off = makeCtx()
  const unloadOff = await setup(off.ctx)
  t.after(() => unloadOff())
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.strictEqual(connections, 0, "wire-only mode must not open any connection (probe included)")
  // The wire-only pipeline owns globalThis until unloaded; a second setup would just be
  // an observer instance and never build (or probe) — unload first (idempotent in t.after)
  await unloadOff()

  // Tracing enabled: exactly one deduped connect (metrics shares the traces endpoint here)
  writeConfig(true)
  const on = makeCtx()
  const unloadOn = await setup(on.ctx)
  t.after(() => unloadOn())
  await waitFor(() => connections >= 1)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.strictEqual(connections, 1, "one connect per distinct endpoint, traces+metrics deduped")
})
