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
