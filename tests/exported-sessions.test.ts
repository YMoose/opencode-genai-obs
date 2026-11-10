/**
 * exported-sessions.ts tests (Bug 39):
 * - mark persists the id and load() round-trips it
 * - missing / corrupt file ⇒ empty set, no throw
 * - FIFO cap trims the oldest ids (cap injected small for the test)
 * - marks are idempotent (no duplicate ids in the file)
 */
import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createExportedSessionsStore } from "../src/exported-sessions.js"
import { tempDir } from "./helpers.js"

const readState = (path: string): string[] => JSON.parse(readFileSync(path, "utf-8")).exported as string[]

test("Bug 39: the first mark creates the state file and load() round-trips the id", (t) => {
  const dir = tempDir("ocg-exp-roundtrip-")
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const statePath = join(dir, "exported-sessions.json")
  const logs: string[] = []
  const store = createExportedSessionsStore((msg) => logs.push(msg), { path: statePath })

  assert.strictEqual(store.load().size, 0, "a missing file starts empty")
  assert.ok(!existsSync(statePath), "load must not create the file")

  store.mark("ses_1")
  assert.ok(existsSync(statePath), "the first mark creates the state file")
  assert.deepStrictEqual(readState(statePath), ["ses_1"], "the marked id is persisted")
  assert.deepStrictEqual([...store.load()], ["ses_1"], "load returns the persisted id")
  assert.ok(logs.length === 0, "no warnings on the happy path")
})

test("Bug 39: a corrupt state file degrades to an empty set without throwing", (t) => {
  const dir = tempDir("ocg-exp-corrupt-")
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const statePath = join(dir, "exported-sessions.json")
  writeFileSync(statePath, "{not json", "utf-8")
  const logs: string[] = []
  const store = createExportedSessionsStore((msg) => logs.push(msg), { path: statePath })

  let loaded: Set<string> | undefined
  assert.doesNotThrow(() => {
    loaded = store.load()
  }, "a corrupt file must not throw on load")
  assert.strictEqual(loaded!.size, 0, "a corrupt file reads as empty")

  // Recovery: the next mark rewrites the file with valid JSON
  store.mark("ses_2")
  assert.deepStrictEqual(readState(statePath), ["ses_2"], "mark rewrites a valid file over the corrupt one")
})

test("Bug 39: the FIFO cap trims the oldest ids and keeps the newest", (t) => {
  const dir = tempDir("ocg-exp-fifo-")
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const statePath = join(dir, "exported-sessions.json")
  const store = createExportedSessionsStore(() => {}, { path: statePath, capacity: 4 })

  for (let i = 1; i <= 5; i++) store.mark(`ses_${i}`)
  assert.deepStrictEqual(readState(statePath), ["ses_2", "ses_3", "ses_4", "ses_5"], "cap 4 keeps the newest 4 ids")
  // A fresh store = a new process reading the trimmed file; the in-memory set of the
  // writing process legitimately still knows ses_1 (it marked it), so assert via reload
  const reloaded = createExportedSessionsStore(() => {}, { path: statePath })
  assert.ok(!reloaded.load().has("ses_1"), "a fresh reader no longer sees the trimmed id")
  assert.ok(reloaded.load().has("ses_5"), "the newest id survives the cap")
})

test("Bug 39: marking an already-persisted id writes no duplicate", (t) => {
  const dir = tempDir("ocg-exp-dup-")
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const statePath = join(dir, "exported-sessions.json")
  const store = createExportedSessionsStore(() => {}, { path: statePath })

  store.mark("ses_1")
  store.mark("ses_1")
  store.mark("ses_1")
  assert.deepStrictEqual(readState(statePath), ["ses_1"], "repeated marks persist exactly one entry")
})
