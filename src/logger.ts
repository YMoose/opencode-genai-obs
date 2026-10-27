/**
 * @fileoverview Process-wide singleton logger: file + stderr fallback + 7-day retention + secret
 * redaction. Adapted from oh-my-opencode-slim src/utils/logger.ts.
 *
 * - File names carry an ISO timestamp + pid (no clashes across processes/instances)
 * - Falls back to stderr automatically when file writes fail
 * - All writes are serialized through a promise chain (never blocks the event loop)
 * - Every entry goes through redactSecrets (sk-/ghp_/Bearer etc.); callers cannot bypass it
 */

import * as fs from "node:fs"
import { appendFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { redactSecrets } from "./redact.js"

const PREFIX = "ocg-obs."
const SUFFIX = ".log"
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Process start time (ISO, dashes/colons stripped) so the file name stays stable within a process */
const STAMP = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)

type Sink = { kind: "uninitialized" } | { kind: "file"; filePath: string } | { kind: "stderr" }

let sink: Sink = { kind: "uninitialized" }
let writeChain: Promise<void> = Promise.resolve()

function logDir(): string {
  return process.env.OPENCODE_LOG_DIR ?? path.join(os.homedir(), ".local", "share", "opencode", "log")
}

function cleanup(dir: string): void {
  try {
    const now = Date.now()
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.startsWith(PREFIX) || !entry.endsWith(SUFFIX)) continue
      const filePath = path.join(dir, entry)
      try {
        if (now - fs.statSync(filePath).mtimeMs > RETENTION_MS) fs.unlinkSync(filePath)
      } catch { /* skip individual errors */ }
    }
  } catch { /* dir may not exist yet */ }
}

export function initLogger(tag?: string): void {
  const dir = logDir()
  // Already initialized in this dir (multi-instance/reload): reuse it and only run
  // retention cleanup
  if (sink.kind === "file" && path.dirname(sink.filePath) === dir) {
    cleanup(dir)
    return
  }
  try {
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, `${PREFIX}${tag ? `${tag}-` : ""}${STAMP}-${process.pid}${SUFFIX}`)
    fs.closeSync(fs.openSync(filePath, "a"))
    sink = { kind: "file", filePath }
    cleanup(dir)
  } catch {
    sink = { kind: "stderr" }
    safeStderr("[ocg-obs] file logging unavailable, falling back to stderr")
  }
}

function safeStderr(message: string): void {
  try { console.error(message) } catch { /* best-effort */ }
}

export function log(message: string, data?: unknown): void {
  try {
    if (sink.kind === "uninitialized") return
    const timestamp = new Date().toISOString()
    let dataStr = ""
    if (data !== undefined) {
      try { dataStr = ` ${JSON.stringify(data)}` } catch { dataStr = " [unserializable]" }
    }
    // Every sink (file, stderr, write-failure stderr fallback) funnels through this
    // one redaction call
    const entry = redactSecrets(`[${timestamp}] ${message}${dataStr}\n`)

    if (sink.kind === "stderr") {
      safeStderr(entry.trimEnd())
      return
    }

    const filePath = sink.filePath
    writeChain = writeChain
      .catch(() => undefined)
      .then(async () => {
        try {
          await appendFile(filePath, entry)
        } catch {
          sink = { kind: "stderr" }
          safeStderr("[ocg-obs] file append failed, falling back to stderr")
          safeStderr(entry.trimEnd())
        }
      })
      .catch(() => undefined)
  } catch { /* logging must remain best-effort */ }
}

/** Test helper: wait for all queued writes to complete */
export async function flushForTesting(): Promise<void> {
  await writeChain
}

/** Test helper: reset the process-wide singleton sink and write chain (never call from production code) */
export function resetLoggerForTesting(): void {
  sink = { kind: "uninitialized" }
  writeChain = Promise.resolve()
}
