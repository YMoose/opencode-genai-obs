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

test("pending 帧 FIFO 消费，耗尽后再取为 undefined", () => {
  const recorder = createWireRecorder({ enabled: true, directory: tempDir("ocg-wire-pending-"), maxFrameBytes: -1 }, () => {})
  recorder.recordWsSend(hookEvent("s2", "f1") as never)
  recorder.recordWsSend(hookEvent("s2", "f2") as never)
  assert.strictEqual(recorder.consumePending("s2")?.frame, "f1")
  assert.strictEqual(recorder.consumePending("s2")?.frame, "f2")
  assert.strictEqual(recorder.consumePending("s2"), undefined)
  assert.strictEqual(recorder.consumePending("missing"), undefined)
  recorder.dispose()
})

test("PENDING_CAP=8：超上限丢最老帧", () => {
  const recorder = createWireRecorder({ enabled: true, directory: tempDir("ocg-wire-cap-"), maxFrameBytes: -1 }, () => {})
  for (let i = 1; i <= 10; i++) {
    recorder.recordWsSend(hookEvent("s3", `f${i}`) as never)
  }
  // capacity 8: f1/f2 are evicted, the next consume gets f3
  assert.strictEqual(recorder.consumePending("s3")?.frame, "f3")
  recorder.dispose()
})

test("禁用时全部空操作", () => {
  const recorder = createWireRecorder({ enabled: false, directory: "/nonexistent", maxFrameBytes: -1 }, () => {})
  recorder.recordWsSend(hookEvent("s1", "x") as never)
  assert.strictEqual(recorder.consumePending("s1"), undefined)
  recorder.dispose() // must not throw
})

// ------------------------------------------------------- wire.maxFrameBytes（磁盘截断）

test("maxFrameBytes：磁盘只留前 N 字节并标记，pending/spans 路径保留全量帧", async () => {
  const dir = tempDir("ocg-wire-cap-bytes-")
  const recorder = createWireRecorder({ enabled: true, directory: dir, maxFrameBytes: 100 }, () => {})
  const frame = "x".repeat(500)
  recorder.recordWsSend(hookEvent("s1", frame) as never)
  await recorder.dispose()

  const record = JSON.parse(readFileSync(join(dir, "s1.jsonl"), "utf-8").trim().split("\n")[0]!)
  assert.equal(record.truncated, true, "应标记 truncated")
  assert.equal(record.frameBytes, 500, "frameBytes 记录原始字节数")
  assert.ok(record.frame.length <= 100 + "[TRUNCATED]".length, "磁盘 frame = 内容前缀 + 截断标识")
  assert.ok(record.frame.length > 0 && record.frame.endsWith("[TRUNCATED]"), "截断帧以 [TRUNCATED] 标识结尾")

  // 关键设计断言：span 路径拿到的仍是全量帧
  const recorder2 = createWireRecorder({ enabled: true, directory: dir, maxFrameBytes: 100 }, () => {})
  recorder2.recordWsSend(hookEvent("s2", frame) as never)
  assert.equal(recorder2.consumePending("s2")?.frame, frame, "consumePending 必须返回全量帧")
  recorder2.dispose()
})

test("maxFrameBytes=-1（默认）：全量落盘，无 truncated 标记", async () => {
  const dir = tempDir("ocg-wire-full-")
  const recorder = createWireRecorder({ enabled: true, directory: dir, maxFrameBytes: -1 }, () => {})
  recorder.recordWsSend(hookEvent("s1", "y".repeat(300)) as never)
  await recorder.dispose()
  const record = JSON.parse(readFileSync(join(dir, "s1.jsonl"), "utf-8").trim().split("\n")[0]!)
  assert.equal(record.frame.length, 300)
  assert.equal(record.truncated, undefined)
})

test("maxFrameBytes=0：只记元数据，frame 为空但保留原始大小", async () => {
  const dir = tempDir("ocg-wire-meta-only-")
  const recorder = createWireRecorder({ enabled: true, directory: dir, maxFrameBytes: 0 }, () => {})
  recorder.recordWsSend(hookEvent("s1", "z".repeat(500)) as never)
  await recorder.dispose()
  const record = JSON.parse(readFileSync(join(dir, "s1.jsonl"), "utf-8").trim().split("\n")[0]!)
  assert.equal(record.frame, "", "0 = 不输出 frame 内容")
  assert.equal(record.truncated, true)
  assert.equal(record.frameBytes, 500, "原始大小仍记录")
  assert.equal(record.sessionID, "s1", "元数据完整")
})

test("maxFrameBytes：多字节 UTF-8 边界回退到字符边界，不产生替换符", async () => {
  const dir = tempDir("ocg-wire-utf8-")
  const recorder = createWireRecorder({ enabled: true, directory: dir, maxFrameBytes: 10 }, () => {})
  // 每个中文字符 3 字节：30 字节帧在 10 字节处切在第 4 个字符中间，回退到 9 字节边界
  recorder.recordWsSend(hookEvent("s1", "一二三四五六七八九十") as never)
  await recorder.dispose()
  const record = JSON.parse(readFileSync(join(dir, "s1.jsonl"), "utf-8").trim().split("\n")[0]!)
  assert.equal(record.frameBytes, 30)
  assert.equal(record.frame, "一二三[TRUNCATED]", "切在字符边界（9 字节）并追加截断标识")
  assert.ok(!record.frame.includes("\u{FFFD}"), "不得出现 U+FFFD 替换符")
})

test("maxFrameBytes：帧小于上限时原样落盘", async () => {
  const dir = tempDir("ocg-wire-under-")
  const recorder = createWireRecorder({ enabled: true, directory: dir, maxFrameBytes: 4096 }, () => {})
  recorder.recordWsSend(hookEvent("s1", "small") as never)
  await recorder.dispose()
  const record = JSON.parse(readFileSync(join(dir, "s1.jsonl"), "utf-8").trim().split("\n")[0]!)
  assert.equal(record.frame, "small")
  assert.equal(record.truncated, undefined)
})
