/**
 * wire.ts tests:
 * - dispose returns a promise and waits for the flush (Bug 8: fire-and-forget used to truncate the last line)
 * - Pending slots are cleaned up after consumption (Bug 4 follow-up: prevents map leaks in long-lived processes)
 * - PENDING_CAP drops-oldest behavior
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createWireRecorder } from "../src/wire.js"
import { tempDir } from "./helpers.js"

const hookEvent = (sessionID: string, frame: string) => ({
  sessionID,
  agent: "build",
  model: { providerID: "p", modelID: "m" },
  kind: "primary",
  frame,
})

test("Bug 8: dispose waits for the flush; JSONL lands complete on disk", async () => {
  const dir = tempDir("ocg-wire-flush-")
  const recorder = createWireRecorder({ enabled: true, directory: dir, maxFrameBytes: -1 }, () => {})
  recorder.recordWsSend(hookEvent("s1", JSON.stringify({ n: 1 })) as never)
  await recorder.dispose()
  const lines = readFileSync(join(dir, "s1.jsonl"), "utf-8").trim().split("\n")
  assert.strictEqual(lines.length, 1)
  const record = JSON.parse(lines[0]!)
  assert.strictEqual(record.sessionID, "s1")
  assert.strictEqual(record.hook, "ws.send")
  assert.ok(JSON.parse(record.frame).n === 1)
})

test("pending frames are consumed FIFO; further reads return undefined", () => {
  const recorder = createWireRecorder({ enabled: true, directory: tempDir("ocg-wire-pending-"), maxFrameBytes: -1 }, () => {})
  recorder.recordWsSend(hookEvent("s2", "f1") as never)
  recorder.recordWsSend(hookEvent("s2", "f2") as never)
  assert.strictEqual(recorder.consumePending("s2")?.frame, "f1")
  assert.strictEqual(recorder.consumePending("s2")?.frame, "f2")
  assert.strictEqual(recorder.consumePending("s2"), undefined)
  assert.strictEqual(recorder.consumePending("missing"), undefined)
  recorder.dispose()
})

test("PENDING_CAP=8: over the cap drops the oldest frame", () => {
  const recorder = createWireRecorder({ enabled: true, directory: tempDir("ocg-wire-cap-"), maxFrameBytes: -1 }, () => {})
  for (let i = 1; i <= 10; i++) {
    recorder.recordWsSend(hookEvent("s3", `f${i}`) as never)
  }
  // capacity 8: f1/f2 are evicted, the next consume gets f3
  assert.strictEqual(recorder.consumePending("s3")?.frame, "f3")
  recorder.dispose()
})

test("disabled means every operation is a no-op", () => {
  const recorder = createWireRecorder({ enabled: false, directory: "/nonexistent", maxFrameBytes: -1 }, () => {})
  recorder.recordWsSend(hookEvent("s1", "x") as never)
  assert.strictEqual(recorder.consumePending("s1"), undefined)
  recorder.dispose() // must not throw
})

// ------------------------------------------------------- wire.maxFrameBytes (on-disk truncation)

test("maxFrameBytes: disk keeps the first N bytes plus a marker, while pending/spans keep the full frame", async () => {
  const dir = tempDir("ocg-wire-cap-bytes-")
  const recorder = createWireRecorder({ enabled: true, directory: dir, maxFrameBytes: 100 }, () => {})
  const frame = "x".repeat(500)
  recorder.recordWsSend(hookEvent("s1", frame) as never)
  await recorder.dispose()

  const record = JSON.parse(readFileSync(join(dir, "s1.jsonl"), "utf-8").trim().split("\n")[0]!)
  assert.equal(record.truncated, true, "must be marked truncated")
  assert.equal(record.frameBytes, 500, "frameBytes records the original byte count")
  assert.ok(record.frame.length <= 100 + "[TRUNCATED]".length, "on-disk frame = content prefix + truncation marker")
  assert.ok(record.frame.length > 0 && record.frame.endsWith("[TRUNCATED]"), "a truncated frame ends with the [TRUNCATED] marker")

  // Key design assertion: the span path still gets the full frame
  const recorder2 = createWireRecorder({ enabled: true, directory: dir, maxFrameBytes: 100 }, () => {})
  recorder2.recordWsSend(hookEvent("s2", frame) as never)
  assert.equal(recorder2.consumePending("s2")?.frame, frame, "consumePending must return the full frame")
  recorder2.dispose()
})

test("maxFrameBytes=-1 (default): full frame on disk, no truncated marker", async () => {
  const dir = tempDir("ocg-wire-full-")
  const recorder = createWireRecorder({ enabled: true, directory: dir, maxFrameBytes: -1 }, () => {})
  recorder.recordWsSend(hookEvent("s1", "y".repeat(300)) as never)
  await recorder.dispose()
  const record = JSON.parse(readFileSync(join(dir, "s1.jsonl"), "utf-8").trim().split("\n")[0]!)
  assert.equal(record.frame.length, 300)
  assert.equal(record.truncated, undefined)
})

test("maxFrameBytes=0: metadata only; frame is empty but the original size is kept", async () => {
  const dir = tempDir("ocg-wire-meta-only-")
  const recorder = createWireRecorder({ enabled: true, directory: dir, maxFrameBytes: 0 }, () => {})
  recorder.recordWsSend(hookEvent("s1", "z".repeat(500)) as never)
  await recorder.dispose()
  const record = JSON.parse(readFileSync(join(dir, "s1.jsonl"), "utf-8").trim().split("\n")[0]!)
  assert.equal(record.frame, "", "0 = no frame content emitted")
  assert.equal(record.truncated, true)
  assert.equal(record.frameBytes, 500, "original size still recorded")
  assert.equal(record.sessionID, "s1", "metadata is complete")
})

test("maxFrameBytes: multi-byte UTF-8 truncation falls back to a character boundary, no replacement char", async () => {
  const dir = tempDir("ocg-wire-utf8-")
  const recorder = createWireRecorder({ enabled: true, directory: dir, maxFrameBytes: 10 }, () => {})
  // each CJK char is 3 bytes: a 30-byte frame cut at 10 bytes lands mid-4th-char, so back off to the 9-byte boundary
  recorder.recordWsSend(hookEvent("s1", "一二三四五六七八九十") as never)
  await recorder.dispose()
  const record = JSON.parse(readFileSync(join(dir, "s1.jsonl"), "utf-8").trim().split("\n")[0]!)
  assert.equal(record.frameBytes, 30)
  assert.equal(record.frame, "一二三[TRUNCATED]", "cuts at a character boundary (9 bytes) and appends the truncation marker")
  assert.ok(!record.frame.includes("\u{FFFD}"), "must not contain the U+FFFD replacement char")
})

test("maxFrameBytes: frames under the cap land on disk unchanged", async () => {
  const dir = tempDir("ocg-wire-under-")
  const recorder = createWireRecorder({ enabled: true, directory: dir, maxFrameBytes: 4096 }, () => {})
  recorder.recordWsSend(hookEvent("s1", "small") as never)
  await recorder.dispose()
  const record = JSON.parse(readFileSync(join(dir, "s1.jsonl"), "utf-8").trim().split("\n")[0]!)
  assert.equal(record.frame, "small")
  assert.equal(record.truncated, undefined)
})

// ------------------------------------------------------- observe-only degradation (Bug 15)

test("Bug 15: an unusable wire.directory degrades to no-op capture instead of throwing at setup", () => {
  // A regular file as the parent makes mkdirSync fail with ENOTDIR
  const blocker = join(tempDir("ocg-wire-nodir-"), "blocker")
  writeFileSync(blocker, "", "utf-8")
  const logs: string[] = []
  const recorder = createWireRecorder(
    { enabled: true, directory: join(blocker, "raw"), maxFrameBytes: -1 },
    (msg) => logs.push(msg),
  )
  recorder.recordWsSend(hookEvent("s1", "{}") as never)
  assert.strictEqual(recorder.consumePending("s1"), undefined, "no capture happens in degraded mode")
  recorder.dispose()
  assert.ok(logs.some((msg) => msg.includes("wire directory unusable")), "the degradation warns")
})

test("Bug 15: an http.request body that cannot be cloned is skipped, never thrown into the host", () => {
  const logs: string[] = []
  const recorder = createWireRecorder(
    { enabled: true, directory: tempDir("ocg-wire-clone-"), maxFrameBytes: -1 },
    (msg) => logs.push(msg),
  )
  // A disturbed body (already read) makes Request.clone() throw synchronously
  const request = {
    clone() {
      throw new TypeError("Body is unusable: Body has already been read")
    },
  } as unknown as Request
  assert.doesNotThrow(
    () => recorder.recordHttpRequest({ ...hookEvent("s1", ""), request } as never),
    "a disturbed body must not throw into the host hook",
  )
  assert.ok(logs.some((msg) => msg.includes("clone failed")), "the skipped frame warns")
  recorder.dispose()
})
