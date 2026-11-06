/**
 * @fileoverview Raw LLM request bodies shared by the wire recorder and span builder.
 * JSONL fields align with the offline lane's raw-request schema.
 */
export interface CapturedWireFrame {
  readonly frame: string
  /** Recorder-wide monotonically increasing sequence; unique only within captureID. */
  readonly seq: number
  /** Recorder-instance identity; paired with seq because reloads restart the counter. */
  readonly captureID: string
}

export interface WireRecord extends CapturedWireFrame {
  /** Schema version; bump on breaking changes */
  readonly v: 1
  /** ISO8601 with milliseconds */
  readonly ts: string
  readonly hook: "ws.send" | "http.request"
  readonly sessionID: string
  readonly agent: string
  readonly model: { readonly providerID: string; readonly id: string }
  /** Request classification: primary | compaction | title | generate */
  readonly kind: string
  /** Full wire body: the ws.send frame string, or the http.request body text (first maxFrameBytes bytes when capped) */
  readonly frame: string
  /** Present when wire.maxFrameBytes capped the on-disk frame (the pending/span path keeps the full frame) */
  readonly truncated?: true
  /** Original frame size in bytes (present when truncated) */
  readonly frameBytes?: number
}

/** Minimal common shape of hook events (args of ws.send / http.request in v2 SessionHooks) */
export interface WireHookEvent {
  readonly sessionID: string
  readonly agent: string
  readonly model: { readonly providerID: string; readonly modelID?: string; readonly id?: string }
  readonly kind: string
}
