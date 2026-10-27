/**
 * Wire body capture: hangs off opencode v2 session hooks and appends every raw LLM
 * request body as JSONL.
 *
 * Main path: experimental.ws.send (websocket transport, frame: string)
 * Fallback:  http.request (non-ws providers / ws fallback / legacy aisdk path;
 *            the body is a ReadableStream, already cloned on the opencode side)
 *
 * The frame is read-only for us — the hook's frame argument is mutable, we only record
 * it and pass it through untouched. Disk writes are async fire-and-forget; the hook
 * body returns in O(1) and never blocks ws/http.
 */

import { createWriteStream, mkdirSync, chmodSync, type WriteStream } from "node:fs"
import { join } from "node:path"
import type { WireRecord, WireHookEvent } from "./types.js"
import type { WireConfig } from "./config.js"

export interface WireRecorder {
  /** Handle a ws.send event (frame: string) */
  readonly recordWsSend: (event: WireHookEvent & { frame: string }) => void
  /** Handle an http.request event (request: web Request; the body can be read once) */
  readonly recordHttpRequest: (event: WireHookEvent & { request: Request }) => void
  /**
   * Consume one frame for the span builder: the earliest kind=primary frame of the
   * session (FIFO), or undefined. Non-primary frames (compaction/title) stay in a
   * separate tally and never pollute the main-path ordering.
   */
  readonly consumePending: (sessionID: string) => { readonly frame: string; readonly seq: number } | undefined
  /** Close all file handles and wait for flush completion (called on plugin unload) */
  readonly dispose: () => void | Promise<void>
}

export function createWireRecorder(config: WireConfig, log: (msg: string, data?: unknown) => void): WireRecorder {
  /** Pending slots: per-session, per-kind FIFO (the kind=primary queue is consumed by the span builder) */
  const pending = new Map<string, { primary: Array<{ frame: string; seq: number }>; other: number }>()

  const pendingFor = (sessionID: string) => {
    let slot = pending.get(sessionID)
    if (!slot) {
      slot = { primary: [], other: 0 }
      pending.set(sessionID, slot)
    }
    return slot
  }

  const PENDING_CAP = 8 // per-session cap of pending frames (a normal turn has far fewer steps; guards abnormal paths)

  const stash = (sessionID: string, kind: string, frame: string, seq: number) => {
    const slot = pendingFor(sessionID)
    if (kind === "primary") {
      if (slot.primary.length >= PENDING_CAP) slot.primary.shift()
      slot.primary.push({ frame, seq })
    } else slot.other += 1
  }

  if (!config.enabled) {
    // No-ops when disabled — callers never need to check enabled (consumePending simply has nothing)
    return {
      recordWsSend: () => {},
      recordHttpRequest: () => {},
      consumePending: () => undefined,
      dispose: () => {},
    }
  }

  mkdirSync(config.directory, { recursive: true, mode: 0o700 })

  /** One append stream per session (cached by file name), plus a process-wide seq counter */
  const streams = new Map<string, WriteStream>()
  let seq = 0

  // Handle cap for long-lived processes: past the cap close the oldest stream (reopened
  // in append mode on that session's next write — no data lost)
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
    // Pre-existing files may come from other processes; tighten permissions while we're here
    try { chmodSync(path, 0o600) } catch { /* file may have just been created */ }
    return stream
  }

  const write = (record: WireRecord): void => {
    try {
      const stream = streamFor(record.sessionID)
      const line = JSON.stringify(record) + "\n"
      // write() returning false means the kernel buffer is full; we are
      // fire-and-forget and do not apply backpressure
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
      // The body is a ReadableStream; clone before reading so the original is never consumed
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
      // Drop empty slots promptly: sessions are unbounded in long-lived processes;
      // keeps the pending map from leaking
      if (slot.primary.length === 0 && slot.other === 0) pending.delete(sessionID)
      return frame ?? undefined
    },

    dispose() {
      const closing = [...streams.values()]
      streams.clear()
      pending.clear()
      if (closing.length === 0) return
      // Wait for real flush of every stream (process exit could otherwise truncate the last JSONL line)
      return Promise.all(
        closing.map((stream) => new Promise<void>((resolve) => stream.end(() => resolve()))),
      ).then(() => undefined)
    },
  }
}
