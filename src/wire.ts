/**
 * wire body 采集模块：挂 opencode v2 的 session hook，
 * 把每次发往 LLM 的原始请求体追加成 JSONL。
 *
 * 主路径：experimental.ws.send（websocket transport，frame: string）
 * 兜底：  http.request（非 ws provider / ws fallback / 旧 aisdk 路径，
 *          body 是 ReadableStream，opencode 侧已做 clone 回传）
 *
 * 只读不改 frame —— hook 参数里的 frame 是 mutable，我们只记录、原样回传。
 * 写盘异步 fire-and-forget，hook 本体 O(1) 返回，绝不阻塞 ws/http。
 */

import { createWriteStream, mkdirSync, chmodSync, type WriteStream } from "node:fs"
import { join } from "node:path"
import type { WireRecord, WireHookEvent } from "./types.js"
import type { WireConfig } from "./config.js"

export interface WireRecorder {
  /** 处理 ws.send 事件（frame: string） */
  readonly recordWsSend: (event: WireHookEvent & { frame: string }) => void
  /** 处理 http.request 事件（request: web Request，body 只读一次） */
  readonly recordHttpRequest: (event: WireHookEvent & { request: Request }) => void
  /**
   * span builder 消费一帧：取该会话 kind=primary 的最早一帧（FIFO），无则 undefined。
   * 非 primary 帧（compaction/title）留在独立队列，不会污染主路径顺序。
   */
  readonly consumePending: (sessionID: string) => { readonly frame: string; readonly seq: number } | undefined
  /** 关闭所有文件句柄并等待刷盘完成（插件卸载时调用） */
  readonly dispose: () => void | Promise<void>
}

export function createWireRecorder(config: WireConfig, log: (msg: string, data?: unknown) => void): WireRecorder {
  /** pending 槽：per-session、per-kind 的 FIFO（kind=primary 队列被 span builder 消费） */
  const pending = new Map<string, { primary: Array<{ frame: string; seq: number }>; other: number }>()

  const pendingFor = (sessionID: string) => {
    let slot = pending.get(sessionID)
    if (!slot) {
      slot = { primary: [], other: 0 }
      pending.set(sessionID, slot)
    }
    return slot
  }

  const PENDING_CAP = 8 // 单会话待消费帧上限（正常一轮 step 数 << 8；防异常路径泄漏）

  const stash = (sessionID: string, kind: string, frame: string, seq: number) => {
    const slot = pendingFor(sessionID)
    if (kind === "primary") {
      if (slot.primary.length >= PENDING_CAP) slot.primary.shift()
      slot.primary.push({ frame, seq })
    } else slot.other += 1
  }

  if (!config.enabled) {
    // 禁用时返回空操作 —— 调用方无需每次判 enabled（consumePending 也无帧可取）
    return {
      recordWsSend: () => {},
      recordHttpRequest: () => {},
      consumePending: () => undefined,
      dispose: () => {},
    }
  }

  mkdirSync(config.directory, { recursive: true, mode: 0o700 })

  /** 每会话一个 append 流（按文件名缓存），进程级 seq 计数器 */
  const streams = new Map<string, WriteStream>()
  let seq = 0

  // 长驻进程句柄上限：超了关最旧的流（下次该会话写入时以追加模式重开，数据不丢）
  const MAX_OPEN_STREAMS = 64

  const streamFor = (sessionID: string): WriteStream => {
    let stream = streams.get(sessionID)
    if (stream) return stream
    const path = join(config.directory, `${sessionID}.jsonl`)
    stream = createWriteStream(path, { flags: "a", mode: 0o600 })
    stream.on("error", (error) => log(`wire write error ${path}: ${error}`))
    streams.set(sessionID, stream)
    if (streams.size > MAX_OPEN_STREAMS) {
      const oldest = streams.keys().next().value
      if (oldest !== undefined && oldest !== sessionID) {
        streams.get(oldest)?.end()
        streams.delete(oldest)
        log("wire stream cap reached, closed oldest session stream", { sessionID: oldest })
      }
    }
    // 已存在的文件可能非本进程创建，权限也顺手收紧
    try { chmodSync(path, 0o600) } catch { /* 文件可能刚创建 */ }
    return stream
  }

  const write = (record: WireRecord): void => {
    try {
      const stream = streamFor(record.sessionID)
      const line = JSON.stringify(record) + "\n"
      // write 返回 false 表示内核缓冲满，但我们 fire-and-forget，不背压
      stream.write(line, (error) => {
        if (error) log(`wire append error: ${error}`)
      })
    } catch (error) {
      log(`wire record error: ${error}`)
    }
  }

  const modelId = (model: WireHookEvent["model"]) => model.modelID ?? model.id ?? "?"

  return {
    recordWsSend(event) {
      const recordSeq = ++seq
      stash(event.sessionID, event.kind, event.frame, recordSeq)
      write({
        v: 1,
        ts: new Date().toISOString(),
        seq: recordSeq,
        hook: "ws.send",
        sessionID: event.sessionID,
        agent: event.agent,
        model: { providerID: event.model.providerID, id: modelId(event.model) },
        kind: event.kind,
        frame: event.frame,
      })
    },

    recordHttpRequest(event) {
      // body 是 ReadableStream，opencode 侧已 clone 过，我们这里 clone 一次再读
      // 避免把 body 消耗掉（虽然 opencode 已经处理了）
      const recordSeq = ++seq
      const cloned = event.request.clone()
      cloned
        .text()
        .then((body) => {
          stash(event.sessionID, event.kind, body, recordSeq)
          write({
            v: 1,
            ts: new Date().toISOString(),
            seq: recordSeq,
            hook: "http.request",
            sessionID: event.sessionID,
            agent: event.agent,
            model: { providerID: event.model.providerID, id: modelId(event.model) },
            kind: event.kind,
            frame: body,
          })
        })
        .catch((error) => log(`http.request body read error: ${error}`))
    },

    consumePending(sessionID) {
      const slot = pending.get(sessionID)
      if (!slot) return undefined
      const frame = slot.primary.shift()
      // 空槽及时清掉：长驻进程里会话数无界，防 pending Map 泄漏
      if (slot.primary.length === 0 && slot.other === 0) pending.delete(sessionID)
      return frame ?? undefined
    },

    dispose() {
      const closing = [...streams.values()]
      streams.clear()
      pending.clear()
      if (closing.length === 0) return
      // 等所有流真正落盘（否则进程退出可能截断最后一行 JSONL）
      return Promise.all(
        closing.map((stream) => new Promise<void>((resolve) => stream.end(() => resolve()))),
      ).then(() => undefined)
    },
  }
}
