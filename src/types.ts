/**
 * @fileoverview One JSONL record of a raw LLM request body (wire body).
 * Fields align with obsystem/otel-span-exportor/RAW-REQUESTS.md.
 */
export interface WireRecord {
  /** Schema version; bump on breaking changes */
  readonly v: 1
  /** ISO8601 with milliseconds */
  readonly ts: string
  /** Process-wide monotonically increasing sequence, used for ordering within a session */
  readonly seq: number
  readonly hook: "ws.send" | "http.request"
  readonly sessionID: string
  readonly agent: string
  readonly model: { readonly providerID: string; readonly id: string }
  /** Request classification: primary | compaction | title | generate */
  readonly kind: string
  /** Full wire body: the ws.send frame string, or the http.request body text */
  readonly frame: string
}

/** Minimal common shape of hook events (args of ws.send / http.request in v2 SessionHooks) */
export interface WireHookEvent {
  readonly sessionID: string
  readonly agent: string
  readonly model: { readonly providerID: string; readonly modelID?: string; readonly id?: string }
  readonly kind: string
}
