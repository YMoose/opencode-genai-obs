/**
 * logger.ts 测试 —— 模式移植自 oh-my-opencode-slim src/utils/logger.test.ts。
 * 我们的 logger 是进程级单例且无自动 reset，这里用 resetLoggerForTesting()
 * 在每个用例前归位；所有用例的 OPENCODE_LOG_DIR 指向临时目录。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initLogger, log, flushForTesting, resetLoggerForTesting } from "../src/logger.js"
import { snapshotEnv, restoreEnv } from "./helpers.js"

const logFiles = (dir: string): string[] =>
  readdirSync(dir).filter((entry) => entry.startsWith("ocg-obs.") && entry.endsWith(".log"))

function fresh(t: { after: (fn: () => Promise<void> | void) => void }): string {
  const snapshot = snapshotEnv()
  const dir = mkdtempSync(join(tmpdir(), "ocg-logger-"))
  resetLoggerForTesting()
  process.env.OPENCODE_LOG_DIR = dir
  t.after(async () => {
    await flushForTesting()
    restoreEnv(snapshot)
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

test("initLogger 之前 log() 静默 no-op", (t) => {
  const dir = fresh(t)
  log("should not crash")
  assert.deepStrictEqual(logFiles(dir), [])
})

test("initLogger 建进程级日志文件（前缀.时间戳-pid.log）", (t) => {
  const dir = fresh(t)
  initLogger()
  log("hello")
  return (async () => {
    await flushForTesting()
    const files = logFiles(dir)
    assert.strictEqual(files.length, 1)
    assert.match(files[0]!, /^ocg-obs\.\d{8}T\d{6}-\d+\.log$/)
    assert.ok(readFileSync(join(dir, files[0]!), "utf-8").includes("hello"))
  })()
})

test("同目录重复 init 复用同一文件（多实例/重载场景）", (t) => {
  const dir = fresh(t)
  return (async () => {
    initLogger()
    log("from first instance")
    initLogger()
    log("from second instance")
    await flushForTesting()
    const files = logFiles(dir)
    assert.strictEqual(files.length, 1, "同目录不新建文件")
    const content = readFileSync(join(dir, files[0]!), "utf-8")
    assert.ok(content.includes("from first instance"))
    assert.ok(content.includes("from second instance"))
  })()
})

test("落盘内容经过脱敏：sk- token 不进日志文件", (t) => {
  const dir = fresh(t)
  const token = ["sk-", "proj-abcdef123456", "abcdef"].join("")
  return (async () => {
    initLogger()
    log("request failed", { auth: `Bearer ${["eyJabc", ".payload.sig"].join("")}`, key: token })
    await flushForTesting()
    const [file] = logFiles(dir)
    const content = readFileSync(join(dir, file!), "utf-8")
    assert.ok(!content.includes(token), "sk- token 必须被掩码")
    assert.ok(!content.includes("eyJabc.payload.sig"), "Bearer 凭证必须被掩码")
    assert.ok(content.includes("sk-p"), "掩码保留前缀，便于对账")
  })()
})

test("日志目录不可写时降级 stderr，不抛错", (t) => {
  const snapshot = snapshotEnv()
  const dir = mkdtempSync(join(tmpdir(), "ocg-logger-blocked-"))
  const blocked = join(dir, "not-a-directory")
  writeFileSync(blocked, "not a directory")
  resetLoggerForTesting()
  process.env.OPENCODE_LOG_DIR = blocked
  const errors: string[] = []
  const original = console.error
  console.error = (message?: unknown) => errors.push(String(message))
  t.after(async () => {
    console.error = original
    await flushForTesting()
    restoreEnv(snapshot)
    rmSync(dir, { recursive: true, force: true })
  })
  return (async () => {
    initLogger() // mkdirSync 失败 → 降级
    log("still works")
    await flushForTesting()
    console.error = original
    assert.ok(errors.some((line) => line.includes("[ocg-obs] file logging unavailable")), "应输出降级提示")
    assert.ok(errors.some((line) => line.includes("still works")), "降级后日志走 stderr")
  })()
})
