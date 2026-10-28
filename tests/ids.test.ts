/**
 * ids.ts contract tests: exact hex outputs are PINNED LITERALS, recomputed independently
 * (node crypto one-liner, not via src/ids.ts) — so any formula drift goes red here.
 *
 * These formulas are a frozen cross-system contract, byte-identical to
 * obsystem/otel-span-exportor/adapter.py. If this suite fails, you are changing the
 * contract (breaking offline-replay dedup), not fixing a bug.
 */
import test from "node:test"
import assert from "node:assert/strict"
import {
  turnTraceId,
  turnSpanId,
  chatSpanId,
  toolSpanId,
  sessionSpanId,
  orphanTraceId,
  compactionTraceId,
  compactionSpanId,
} from "../src/ids.js"

test("ID 契约冻结：已知输入的精确输出（红了 = 你在改契约，不是在修 bug）", () => {
  assert.equal(turnTraceId("ses_X", "msg_Y"), "afcd33c83d11c5e7c8775ab2d910c17a")
  assert.equal(turnSpanId("ses_X", "msg_Y"), "21827aa15490503f")
  assert.equal(chatSpanId("asst_Z"), "b8ab94b3814dbe0d")
  assert.equal(toolSpanId("asst_Z", "call_W"), "16917a4c2292d06a")
  assert.equal(sessionSpanId("ses_child"), "b9d2811601e82a6b")
  assert.equal(orphanTraceId("ses_child"), "c4ff3ddabe7f04bff47bcd5a2c06c2b8")
  assert.equal(compactionTraceId("ses_X", "1729"), "dfdc9987bcc1b1929a7f5ddefbd0d748")
  assert.equal(compactionSpanId("ses_X", "1729"), "47a0ab348004b544")
})

test("ID 契约冻结：trace 32 hex / span 16 hex 长度恒定", () => {
  assert.equal(turnTraceId("a", "b").length, 32)
  assert.equal(orphanTraceId("a").length, 32)
  assert.equal(compactionTraceId("a", "1").length, 32)
  assert.equal(chatSpanId("a").length, 16)
  assert.equal(toolSpanId("a", "b").length, 16)
  assert.equal(turnSpanId("a", "b").length, 16)
  assert.equal(sessionSpanId("a").length, 16)
  assert.equal(compactionSpanId("a", "1").length, 16)
})
