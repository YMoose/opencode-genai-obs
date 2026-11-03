/**
 * @fileoverview GenAI-semconv message events (opt-in logs lane) — the five
 * gen_ai.* events of the OTel GenAI "events" model collapse to four emitted
 * (assistant.message folds into choice), mapped to what our pipeline can
 * source without new capture:
 *
 *   gen_ai.system.message    — system prompt, extracted best-effort from the wire frame
 *   gen_ai.user.message      — the turn's user prompt
 *   gen_ai.tool.message      — one per tool result
 *   gen_ai.choice            — the LLM completion of each step (finish_reason + content)
 *
 * gen_ai.assistant.message is deliberately not emitted: opencode's per-step text IS the
 * completion — emitting both would duplicate content (assistant.message is meant for
 * replayed history, which we never replay).
 *
 * Content gates are applied by the caller (spans.ts passes `content: undefined` when a
 * gate is off); a gated event still fires, metadata-only — same semantics as Claude
 * Code's OTEL_LOG_*=false. Every record carries the deterministic span context of its
 * origin span, so backends can correlate log ↔ trace.
 */
import { trace, ROOT_CONTEXT } from "@opentelemetry/api"
import { SeverityNumber } from "@opentelemetry/api-logs"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { LoggerProvider } from "@opentelemetry/sdk-logs"
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto"
import { PLUGIN_VERSION } from "./version.js"
import { cutUtf8Bytes } from "./truncate.js"

/**
 * One message-event observation. `content: undefined` = the gate is off → metadata-only.
 * traceId/spanId point at the deterministic span this message belongs to.
 */
export type LogObservation =
  | { readonly event: "user"; readonly sessionID: string; readonly timeMs: number; readonly traceId: string; readonly spanId: string; readonly content: string | undefined }
  | { readonly event: "system"; readonly sessionID: string; readonly timeMs: number; readonly traceId: string; readonly spanId: string; readonly frame: string; readonly gated: boolean }
  | {
      readonly event: "tool"
      readonly sessionID: string
      readonly timeMs: number
      readonly traceId: string
      readonly spanId: string
      readonly callId: string
      readonly tool: string
      readonly content: string | undefined
      readonly failed: boolean
    }
  | {
      readonly event: "choice"
      readonly sessionID: string
      readonly timeMs: number
      readonly traceId: string
      readonly spanId: string
      readonly provider: string
      readonly model: string
      readonly finishReason: string | undefined
      readonly content: string | undefined
    }

export interface LogsOptions {
  /** Base URL; /v1/logs is appended here */
  readonly endpoint: string
  /** Extra request headers (auth etc.) */
  readonly headers?: Record<string, string>
  /** Custom attributes merged into the OTLP resource block (service.name overridable) */
  readonly resourceAttributes?: Record<string, string>
  /** Max content bytes per event body field (same budget as tracing.contentMaxLength) */
  readonly contentMaxLength: number
  /** BatchLogRecordProcessor scheduledDelayMillis (default 2000, from logs.intervalMs) */
  readonly intervalMs?: number
}

export interface Logs {
  readonly emit: (obs: LogObservation) => void
  /** Flush the batch processor and release the exporter (called on plugin unload) */
  readonly shutdown: () => Promise<void>
}

/**
 * Best-effort system-prompt extraction from a raw provider request frame. Two wire
 * shapes are recognized: OpenAI-style (messages[0].role is "system"/"developer") and
 * Anthropic-style (top-level "system", string or text-part array). Anything else →
 * undefined (no event) — the frame is already on the chat span's input.value.
 */
function extractSystemText(frame: string): string | undefined {
  let body: unknown
  try {
    body = JSON.parse(frame)
  } catch {
    return undefined
  }
  if (typeof body !== "object" || body === null) return undefined
  const textOf = (content: unknown): string | undefined => {
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      const parts = content
        .map((part) => (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : ""))
        .filter(Boolean)
      return parts.length ? parts.join("\n") : undefined
    }
    return undefined
  }
  const messages = (body as { messages?: unknown }).messages
  if (Array.isArray(messages) && messages.length > 0) {
    const first = messages[0] as { role?: unknown; content?: unknown }
    if (first?.role === "system" || first?.role === "developer") return textOf(first.content)
  }
  const system = (body as { system?: unknown }).system
  return textOf(system)
}

export function createLogs(options: LogsOptions): Logs {
  const resource = resourceFromAttributes({
    ...options.resourceAttributes,
    "service.name": options.resourceAttributes?.["service.name"] ?? "opencode-genai-obs",
  })
  const provider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor(
        new OTLPLogExporter({
          url: `${options.endpoint.replace(/\/+$/, "")}/v1/logs`,
          headers: options.headers,
        }),
        { scheduledDelayMillis: options.intervalMs ?? 2_000, maxExportBatchSize: 64 },
      ),
    ],
  })
  const logger = provider.getLogger("opencode-genai-obs", PLUGIN_VERSION)

  const limit = options.contentMaxLength
  /**
   * Clip one content string per the contentMaxLength budget (same three states as
   * tracing.contentMaxLength). `content` comes back undefined when the gate is off (no text
   * passed in) or the budget is 0 — callers then omit the key entirely, because a
   * `{ content: undefined }` spread survives Object.keys() and serializes as a
   * present-but-empty kvlist entry (Bug 28). `truncated` says non-empty content was
   * withheld or shortened by the budget → the record gets opencode.content.truncated.
   */
  const clipForLog = (text: string | undefined): { content?: string; truncated: boolean } => {
    if (text === undefined) return { truncated: false }
    if (limit === 0) return { truncated: text.length > 0 }
    if (limit < 0) return { content: text, truncated: false }
    return { content: cutUtf8Bytes(text, limit), truncated: Buffer.byteLength(text, "utf-8") > limit }
  }

  /** Envelope cover for contentMaxLength (log-record attributes, not the gen_ai.* body) */
  const truncatedAttr = (truncated: boolean): Record<string, boolean> =>
    truncated ? { "opencode.content.truncated": true } : {}

  const emitRecord = (obs: LogObservation, eventName: string, body: Record<string, unknown>, attributes: Record<string, string | number | boolean>) => {
    logger.emit({
      eventName,
      severityNumber: SeverityNumber.INFO,
      timestamp: obs.timeMs,
      body: body as Parameters<typeof logger.emit>[0]["body"],
      attributes: { "gen_ai.conversation.id": obs.sessionID, ...attributes },
      // Deterministic span context → the backend can join this event to its span
      context: trace.setSpanContext(ROOT_CONTEXT, { traceId: obs.traceId, spanId: obs.spanId, traceFlags: 1 }),
    })
  }

  return {
    emit(obs) {
      switch (obs.event) {
        case "user": {
          const { content, truncated } = clipForLog(obs.content)
          emitRecord(
            obs,
            "gen_ai.user.message",
            { role: "user", ...(content !== undefined ? { content } : {}) },
            truncatedAttr(truncated),
          )
          return
        }
        case "system": {
          const text = extractSystemText(obs.frame)
          if (text === undefined) return
          const { content, truncated } = clipForLog(obs.gated ? undefined : text)
          emitRecord(
            obs,
            "gen_ai.system.message",
            { role: "system", ...(content !== undefined ? { content } : {}) },
            truncatedAttr(truncated),
          )
          return
        }
        case "tool": {
          const { content, truncated } = clipForLog(obs.content)
          emitRecord(
            obs,
            "gen_ai.tool.message",
            { role: "tool", id: obs.callId, name: obs.tool, ...(content !== undefined ? { content } : {}) },
            { ...(obs.failed ? { "error.type": "tool_error" } : {}), ...truncatedAttr(truncated) },
          )
          return
        }
        case "choice": {
          const { content, truncated } = clipForLog(obs.content)
          emitRecord(
            obs,
            "gen_ai.choice",
            {
              finish_reason: obs.finishReason ?? "unknown",
              index: 0,
              message: { role: "assistant", ...(content !== undefined ? { content } : {}) },
            },
            { "gen_ai.provider.name": obs.provider, "gen_ai.request.model": obs.model, ...truncatedAttr(truncated) },
          )
          return
        }
      }
    },
    async shutdown() {
      await provider.shutdown()
    },
  }
}
