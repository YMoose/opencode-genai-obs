/**
 * 进程级单例 logger：文件 + stderr 兜底 + 7 天留存 + 敏感信息脱敏。
 * 参考 oh-my-opencode-slim src/utils/logger.ts。
 *
 * - 文件名含 ISO 时间戳 + pid（多进程/多实例不冲突）
 * - 文件写失败自动降级 stderr
 * - 所有写操作走 promise 链串行化（不阻塞事件循环）
 * - 每条日志过 redactSecrets（sk-/ghp_/Bearer 等），调用方无法绕过
 */

import * as fs from "node:fs"
import { appendFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { redactSecrets } from "./redact.js"

const PREFIX = "ocg-tracing."
const SUFFIX = ".log"
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** 进程启动时刻（ISO，去横杠冒号），保证同进程内文件名稳定 */
const STAMP = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)

type Sink = { kind: "uninitialized" } | { kind: "file"; filePath: string } | { kind: "stderr" }

let sink: Sink = { kind: "uninitialized" }
let writeChain: Promise<void> = Promise.resolve()

function logDir(): string {
  return process.env.OPENCODE_LOG_DIR ?? path.join(os.homedir(), ".local", "share", "opencode", "log")
}

/** 清理超过 7 天的旧日志 */
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
  // 同目录已初始化则复用（多实例/重载场景），只跑留存清理
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
    safeStderr("[ocg-tracing] file logging unavailable, falling back to stderr")
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
    // 所有出口（文件、stderr、写失败降级 stderr）都过这一个脱敏函数
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
          safeStderr("[ocg-tracing] file append failed, falling back to stderr")
          safeStderr(entry.trimEnd())
        }
      })
      .catch(() => undefined)
  } catch { /* logging must remain best-effort */ }
}

/** 测试用：等所有排队的写入完成 */
export async function flushForTesting(): Promise<void> {
  await writeChain
}
