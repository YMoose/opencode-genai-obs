/**
 * @fileoverview Real-time session annotations (Phase 2.5, optional enhancement).
 *
 * Posts to the Phoenix-compatible REST API POST /v1/session_annotations?sync=true
 * (project/title as two CODE annotations, rendered as Sessions-table columns). This is
 * a backend-specific REST API, not an OTLP standard — the project stays platform-neutral,
 * so it is gated by tracing.annotations.enabled (default true for existing deployments;
 * non-Phoenix backends should disable it).
 * DO_UPDATE upsert semantics — rewriting after a rename refreshes the column.
 *
 * Root sessions only: Phoenix-style backends build one ProjectSession per trace keyed by
 * the root span's session.id; sub-agent sessions have no matching record and would 404
 * the whole batch (same boundary as sync.py).
 *
 * Failures warn but never interrupt: span ingestion is an async queue, so an annotation
 * may 404 while its session is still being created — retry 3 times (2s / 4s backoff),
 * then give up silently; the offline sync.py is the backstop.
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
  /** Fire-and-forget safe: all errors are caught internally — logs, never throws */
  readonly annotate: (sessionID: string, fields: SessionAnnotationFields) => Promise<void>
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
    async annotate(sessionID, fields) {
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
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
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
          const exhausted = attempt === MAX_RETRIES
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
