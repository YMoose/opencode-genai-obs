/**
 * @fileoverview Real-time session annotations (optional enhancement).
 *
 * Posts to the Phoenix-compatible REST API POST /v1/session_annotations?sync=true
 * (project/title as two CODE annotations, rendered as Sessions-table columns). This is
 * a backend-specific REST API, not an OTLP standard — the project stays platform-neutral,
 * so it is gated by tracing.annotations.enabled (default true for existing deployments;
 * non-Phoenix backends should disable it).
 * DO_UPDATE upsert semantics — rewriting after a rename refreshes the column.
 *
 * Every session is annotated, sub-agent sessions included: current Phoenix lists one
 * ProjectSession per session id, so children have a record too (the old "root sessions
 * only" boundary no longer holds).
 *
 * Failures warn but never interrupt: span ingestion is an async queue, so an annotation
 * may 404 while its session is still being created — retry 3 times (2s / 4s backoff),
 * then give up silently; the offline sync.py is the backstop. Because a session's first
 * span only lands after its first turn, the plugin additionally re-annotates once shortly
 * after the first terminal execution event (index.ts), and backfills sessions that existed
 * before it loaded. The backfill passes maxRetries=0: a session absent from Phoenix at
 * backfill time has no row to race into existence, so retries are pure noise (Bug 39).
 */

export interface SessionAnnotationFields {
  /** "title" column of the Sessions table */
  readonly title?: string
  /** "project" column of the Sessions table (= basename of the session directory) */
  readonly projectLabel?: string
}

interface AnnotationEntry {
  readonly session_id: string
  readonly name: "project" | "title"
  readonly annotator_kind: "CODE"
  readonly result: { readonly label: string }
}

const MAX_RETRIES = 3

export interface Annotator {
  /**
   * Fire-and-forget safe: all errors are caught internally — logs, never throws.
   * maxRetries bounds total POST attempts (named after the retry policy it replaces);
   * it clamps to ≥1, so 0 means a single attempt. Default 3 (the legacy MAX_RETRIES).
   */
  readonly annotate: (sessionID: string, fields: SessionAnnotationFields, maxRetries?: number) => Promise<void>
}

export function createAnnotator(
  options: {
    readonly endpoint: string
    readonly headers?: Record<string, string>
    /** Per-request timeout in ms, default 30s */
    readonly timeoutMs?: number
    /** Base retry delay in ms (after the n-th failure wait n×base), default 2s */
    readonly retryDelayMs?: number
  },
  log: (msg: string, data?: unknown) => void,
): Annotator {
  const url = options.endpoint.replace(/\/+$/, "") + "/v1/session_annotations?sync=true"
  // Custom headers first, built-ins last so content-type cannot be clobbered
  const headers: Record<string, string> = {
    ...(options.headers ?? {}),
    "content-type": "application/json",
  }

  return {
    async annotate(sessionID, fields, maxRetries = MAX_RETRIES) {
      const attempts = Math.max(1, maxRetries)
      const title = fields.title?.trim()
      const data: AnnotationEntry[] = []
      if (fields.projectLabel) {
        data.push({ session_id: sessionID, name: "project", annotator_kind: "CODE", result: { label: fields.projectLabel } })
      }
      if (title) {
        data.push({ session_id: sessionID, name: "title", annotator_kind: "CODE", result: { label: title } })
      }
      if (data.length === 0) return

      const body = JSON.stringify({ data })
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const response = await fetch(url, {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
          })
          if (response.status !== 200) {
            const text = await response.text().catch(() => "")
            throw new Error(`${response.status} ${text.slice(0, 200)}`)
          }
          log("session annotated", { sessionID, names: data.map((entry) => entry.name).join(",") })
          return
        } catch (error) {
          const exhausted = attempt === attempts
          log(exhausted ? "session annotations gave up (offline sync.py will fill)" : "session annotations attempt failed", {
            sessionID,
            attempt,
            error: String(error),
          })
          if (exhausted) return
          await new Promise((resolve) => setTimeout(resolve, (options.retryDelayMs ?? 2_000) * attempt))
        }
      }
    },
  }
}
