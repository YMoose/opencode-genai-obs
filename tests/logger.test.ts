/**
 * logger.ts tests — pattern ported from oh-my-opencode-slim src/utils/logger.test.ts.
 * Our logger is a process-wide singleton with no auto reset; resetLoggerForTesting()
 * restores it before each case. OPENCODE_LOG_DIR points at temp dirs throughout.
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

test("log() before initLogger is a silent no-op", (t) => {
  const dir = fresh(t)
  log("should not crash")
  assert.deepStrictEqual(logFiles(dir), [])
})

test("initLogger creates a process-wide log file (prefix.timestamp-pid.log)", (t) => {
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

test("repeated init in the same directory reuses one file (multi-instance/reload)", (t) => {
  const dir = fresh(t)
  return (async () => {
    initLogger()
    log("from first instance")
    initLogger()
    log("from second instance")
    await flushForTesting()
    const files = logFiles(dir)
    assert.strictEqual(files.length, 1, "no new file in the same directory")
    const content = readFileSync(join(dir, files[0]!), "utf-8")
    assert.ok(content.includes("from first instance"))
    assert.ok(content.includes("from second instance"))
  })()
})

test("on-disk content is redacted: sk- tokens never reach the log file", (t) => {
  const dir = fresh(t)
  const token = ["sk-", "proj-abcdef123456", "abcdef"].join("")
  return (async () => {
    initLogger()
    log("request failed", { auth: `Bearer ${["eyJabc", ".payload.sig"].join("")}`, key: token })
    await flushForTesting()
    const [file] = logFiles(dir)
    const content = readFileSync(join(dir, file!), "utf-8")
    assert.ok(!content.includes(token), "the sk- token must be masked")
    assert.ok(!content.includes("eyJabc.payload.sig"), "the Bearer credential must be masked")
    assert.ok(content.includes("sk-p"), "the mask keeps the prefix for reconciliation")
  })()
})

test("falls back to stderr when the log directory is unwritable, without throwing", (t) => {
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
    initLogger() // mkdirSync fails → fall back to stderr
    log("still works")
    await flushForTesting()
    console.error = original
    assert.ok(errors.some((line) => line.includes("[ocg-obs] file logging unavailable")), "must emit the fallback notice")
    assert.ok(errors.some((line) => line.includes("still works")), "logs go to stderr after the fallback")
  })()
})
