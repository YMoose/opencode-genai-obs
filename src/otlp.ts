/**
 * @fileoverview OTLP/HTTP export — the official @opentelemetry/exporter-trace-otlp-proto
 * owns the protobuf wire format; this module adapts our SpanRecord (deterministic ids,
 * bigint nanos, tuple attributes) to the SDK's ReadableSpan and wraps export() in a
 * promise for the sender's retry queue.
 *
 * The pipeline deliberately uses the exporter alone — no BasicTracerProvider / global
 * context manager: the IdGenerator interface takes no arguments and cannot express our
 * FROZEN deterministic-id contract (ids.ts hashes semantic content). Everything upstream
 * of this file (span lifecycle, ids, attributes) stays SDK-free.
 */
import { SpanKind, SpanStatusCode, type HrTime } from "@opentelemetry/api"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { ExportResultCode, type InstrumentationScope } from "@opentelemetry/core"
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import { PLUGIN_VERSION } from "./version.js"

export type AttrValue = string | number | boolean

export interface SpanRecord {
  readonly traceId: string // 32 hex chars
  readonly spanId: string // 16 hex chars
  readonly parentSpanId?: string
  readonly name: string
  readonly kind: number // 1=INTERNAL 3=CLIENT (OTLP enum numbering)
  readonly startTimeUnixNano: bigint
  readonly endTimeUnixNano: bigint
  readonly attributes: ReadonlyArray<readonly [string, AttrValue]>
  readonly status: { readonly code: number; readonly message?: string } // 1=OK 2=ERROR
}

const SCOPE: InstrumentationScope = { name: "opencode-genai-obs", version: PLUGIN_VERSION }

/** bigint nanos → HrTime [seconds, sub-second nanos] */
const nanoToHr = (nano: bigint): HrTime => [Number(nano / 1_000_000_000n), Number(nano % 1_000_000_000n)]

const validParent = (hex: string): boolean => /^[0-9a-f]{16}$/.test(hex) && hex !== "0".repeat(16)

/**
 * Our kind/status use the OTLP protobuf numbering, which matches the api enums
 * numerically; the default branch keeps future enum additions pass-through.
 */
const toSpanKind = (kind: number): SpanKind => (kind === 3 ? SpanKind.CLIENT : SpanKind.INTERNAL)

const toStatus = (status: SpanRecord["status"]) => ({
  code: status.code === 2 ? SpanStatusCode.ERROR : status.code === 1 ? SpanStatusCode.OK : SpanStatusCode.UNSET,
  ...(status.message ? { message: status.message } : {}),
})

/** Adapt one SpanRecord; resource is shared per exporter and passed in */
function toReadableSpan(span: SpanRecord, resource: ReturnType<typeof resourceFromAttributes>): ReadableSpan {
  const start = nanoToHr(span.startTimeUnixNano)
  const end = nanoToHr(span.endTimeUnixNano)
  return {
    name: span.name,
    kind: toSpanKind(span.kind),
    spanContext: () => ({ traceId: span.traceId, spanId: span.spanId, traceFlags: 1 }),
    // The transformer turns an invalid parent SpanContext into "no parent"; our
    // records carry bare hex without flags, so construct a valid one explicitly
    parentSpanContext:
      span.parentSpanId && validParent(span.parentSpanId)
        ? { traceId: span.traceId, spanId: span.parentSpanId, traceFlags: 1 }
        : undefined,
    startTime: start,
    endTime: end,
    status: toStatus(span.status),
    attributes: Object.fromEntries(span.attributes),
    links: [],
    events: [],
    duration: nanoToHr(span.endTimeUnixNano - span.startTimeUnixNano),
    ended: true,
    resource,
    instrumentationScope: SCOPE,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  }
}

export interface ExporterOptions {
  /** Base URL (http://host:port); /v1/traces is appended here — the exporter treats config.url as the full signal path */
  readonly endpoint: string
  /** Project name (openinference.project.name resource attribute, OpenInference convention) */
  readonly project?: string
  /** Extra request headers (auth etc.); never overrides content-type */
  readonly headers?: Record<string, string>
  /** Custom attributes merged into the resource block; builtin keys win on conflicts */
  readonly resourceAttributes?: Record<string, string>
  /** Per-request timeout in ms, default 30s (a half-open peer must not hang the pump/unload path) */
  readonly timeoutMs?: number
}

export interface TraceExporter {
  /** Rejects on failure (the sender owns the retry queue) */
  readonly exportBatch: (spans: readonly SpanRecord[]) => Promise<void>
  /** Release the exporter's http agent; drain the queue first */
  readonly close: () => Promise<void>
}

export function createTraceExporter(options: ExporterOptions): TraceExporter {
  // Builtin keys win over user-supplied resourceAttributes (Claude Code semantics),
  // except service.name: OTEL_SERVICE_NAME / config resourceAttributes may override it,
  // falling back to our builtin identity.
  const resource = resourceFromAttributes({
    ...Object.fromEntries(
      Object.entries(options.resourceAttributes ?? {}).filter(([key]) => key !== "openinference.project.name"),
    ),
    "service.name": options.resourceAttributes?.["service.name"] ?? "opencode-genai-obs",
    ...(options.project ? { "openinference.project.name": options.project } : {}),
  })

  const exporter = new OTLPTraceExporter({
    url: `${options.endpoint.replace(/\/+$/, "")}/v1/traces`,
    headers: options.headers,
    timeoutMillis: options.timeoutMs ?? 30_000,
  })

  return {
    exportBatch(spans) {
      const batch = spans.map((span) => toReadableSpan(span, resource))
      return new Promise((resolve, reject) => {
        exporter.export(batch, (result) => {
          if (result.code === ExportResultCode.SUCCESS) {
            resolve()
          } else {
            reject(result.error ?? new Error("OTLP export failed"))
          }
        })
      })
    },
    async close() {
      await exporter.shutdown()
    },
  }
}
