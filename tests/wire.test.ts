/**
 * wire.ts tests:
 * - dispose returns a promise and waits for the flush (Bug 8: fire-and-forget used to truncate the last line)
 * - Pending slots are cleaned up after consumption (Bug 4 follow-up: prevents map leaks in long-lived processes)
 * - PENDING_CAP drops-oldest behavior
 * - Post-dispose frames are dropped with a log, never appended via a zombie stream (Bug 27)
 */
import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
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

test("Bug 18: http.request frames land in seq order even when body reads complete out of order", async () => {
  const dir = tempDir("ocg-wire-seq-")
  const recorder = createWireRecorder({ enabled: true, directory: dir, maxFrameBytes: -1 }, () => {})
  const deferred = () => {
    let resolve!: (body: string) => void
    const promise = new Promise<string>((r) => { resolve = r })
    return { promise, resolve }
  }
  const httpEvent = (request: unknown) =>
    ({ ...hookEvent("s1", ""), request: request as Request }) as never

  // request 1: body resolves LATE; request 2: body resolves immediately
  const first = deferred()
  recorder.recordHttpRequest(httpEvent({ clone: () => ({ text: () => first.promise }) }))
  recorder.recordHttpRequest(httpEvent({ clone: () => ({ text: () => Promise.resolve("BBBB-frame") }) }))
  await new Promise((r) => setTimeout(r, 25))
  assert.strictEqual(recorder.consumePending("s1"), undefined, "frame 2 must not overtake frame 1 while frame 1 is still in flight (seq = issue order)")

  first.resolve("AAAA-frame")
  await new Promise((r) => setTimeout(r, 25))
  assert.strictEqual(recorder.consumePending("s1")?.frame, "AAAA-frame", "FIFO follows issue order, not completion order")
  assert.strictEqual(recorder.consumePending("s1")?.frame, "BBBB-frame")

  // dispose must let an in-flight read land before the streams close
  const third = deferred()
  recorder.recordHttpRequest(httpEvent({ clone: () => ({ text: () => third.promise }) }))
  const disposed = recorder.dispose()
  third.resolve("CCCC-frame")
  await disposed
  const lines = readFileSync(join(dir, "s1.jsonl"), "utf-8").trim().split("\n")
  assert.deepEqual(
    lines.map((line) => ({ seq: JSON.parse(line).seq, frame: JSON.parse(line).frame })),
    [
      { seq: 1, frame: "AAAA-frame" },
      { seq: 2, frame: "BBBB-frame" },
      { seq: 3, frame: "CCCC-frame" },
    ],
    "JSONL lines land in seq order and the in-flight frame flushes before dispose resolves",
  )
})

// ------------------------------------------------------- post-dispose drops (Bug 27)

test("Bug 27: a ws.send arriving after dispose is dropped with a log, never a zombie append", async () => {
  const dir = tempDir("ocg-wire-postdispose-ws-")
  const logs: Array<{ msg: string; data?: unknown }> = []
  const recorder = createWireRecorder(
    { enabled: true, directory: dir, maxFrameBytes: -1 },
    (msg, data) => logs.push({ msg, data }),
  )
  recorder.recordWsSend(hookEvent("s1", JSON.stringify({ n: 1 })) as never)
  await recorder.dispose()
  const baseline = readFileSync(join(dir, "s1.jsonl"), "utf-8")

  // The ws.send hook path is synchronous: the host can still call it after unload began.
  // The old behavior reopened a stream nobody .end()s (zombie append).
  recorder.recordWsSend(hookEvent("s1", JSON.stringify({ late: true })) as never)
  await new Promise((r) => setTimeout(r, 25))

  assert.equal(
    readFileSync(join(dir, "s1.jsonl"), "utf-8"),
    baseline,
    "no new JSONL line may be appended after dispose",
  )
  const dropped = logs.filter((e) => e.msg.includes("dropped after dispose"))
  assert.equal(dropped.length, 1, "exactly one drop log fires (dropped loudly, not silently truncated)")
  assert.equal((dropped[0]?.data as { hook?: string })?.hook, "ws.send", "the drop log names the hook kind")
  assert.equal((dropped[0]?.data as { sessionID?: string })?.sessionID, "s1", "the drop log names the session")
  assert.equal(recorder.consumePending("s1"), undefined, "pending is not re-populated after dispose")
})

test("Bug 27: an http.request tail landing after dispose is dropped with a log, never a zombie append", async () => {
  const dir = tempDir("ocg-wire-postdispose-http-")
  const logs: Array<{ msg: string; data?: unknown }> = []
  const recorder = createWireRecorder(
    { enabled: true, directory: dir, maxFrameBytes: -1 },
    (msg, data) => logs.push({ msg, data }),
  )
  await recorder.dispose()

  // The cloned body resolves immediately, but dispose's chain await has already finished:
  // queuing this read now would reassign readChain past dispose and write via a zombie stream.
  recorder.recordHttpRequest({
    ...hookEvent("s1", ""),
    request: { clone: () => ({ text: () => Promise.resolve("late-http-frame") }) } as unknown as Request,
  } as never)
  await new Promise((r) => setTimeout(r, 25))

  assert.ok(!existsSync(join(dir, "s1.jsonl")), "no JSONL line (not even the file) is written after dispose")
  const dropped = logs.filter((e) => e.msg.includes("dropped after dispose"))
  assert.equal(dropped.length, 1, "exactly one drop log fires (dropped loudly, not silently truncated)")
  assert.equal((dropped[0]?.data as { hook?: string })?.hook, "http.request", "the drop log names the hook kind")
  assert.equal((dropped[0]?.data as { sessionID?: string })?.sessionID, "s1", "the drop log names the session")
})
