/**
 * wire.ts tests:
 * - dispose returns a promise and waits for the flush (Bug 8: fire-and-forget used to truncate the last line)
 * - Pending slots are cleaned up after consumption (Bug 4 follow-up: prevents map leaks in long-lived processes)
 * - PENDING_CAP drops-oldest behavior
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
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

test("Bug 8：dispose 等待刷盘，JSONL 完整落盘", async () => {
  const dir = tempDir("ocg-wire-flush-")
  const recorder = createWireRecorder({ enabled: true, directory: dir }, () => {})
  recorder.recordWsSend(hookEvent("s1", JSON.stringify({ n: 1 })) as never)
  await recorder.dispose()
  const lines = readFileSync(join(dir, "s1.jsonl"), "utf-8").trim().split("\n")
  assert.strictEqual(lines.length, 1)
  const record = JSON.parse(lines[0]!)
  assert.strictEqual(record.sessionID, "s1")
  assert.strictEqual(record.hook, "ws.send")
  assert.ok(JSON.parse(record.frame).n === 1)
})

test("pending 帧 FIFO 消费，耗尽后再取为 undefined", () => {
  const recorder = createWireRecorder({ enabled: true, directory: tempDir("ocg-wire-pending-") }, () => {})
  recorder.recordWsSend(hookEvent("s2", "f1") as never)
  recorder.recordWsSend(hookEvent("s2", "f2") as never)
  assert.strictEqual(recorder.consumePending("s2")?.frame, "f1")
  assert.strictEqual(recorder.consumePending("s2")?.frame, "f2")
  assert.strictEqual(recorder.consumePending("s2"), undefined)
  assert.strictEqual(recorder.consumePending("missing"), undefined)
  recorder.dispose()
})

test("PENDING_CAP=8：超上限丢最老帧", () => {
  const recorder = createWireRecorder({ enabled: true, directory: tempDir("ocg-wire-cap-") }, () => {})
  for (let i = 1; i <= 10; i++) {
    recorder.recordWsSend(hookEvent("s3", `f${i}`) as never)
  }
  // capacity 8: f1/f2 are evicted, the next consume gets f3
  assert.strictEqual(recorder.consumePending("s3")?.frame, "f3")
  recorder.dispose()
})

test("禁用时全部空操作", () => {
  const recorder = createWireRecorder({ enabled: false, directory: "/nonexistent" }, () => {})
  recorder.recordWsSend(hookEvent("s1", "x") as never)
  assert.strictEqual(recorder.consumePending("s1"), undefined)
  recorder.dispose() // must not throw
})
