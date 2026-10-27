/**
 * OTLP/HTTP protobuf encoder + POST — a dependency-free TS port of otlp.py.
 * Encodes a stable subset of opentelemetry/proto/collector/trace/v1
 * ExportTraceServiceRequest: Resource/Scope/Span/KeyValue/AnyValue/Status.
 * Standard receivers (OTel Collector etc.) require application/x-protobuf on /v1/traces.
 */

export type AttrValue = string | number | boolean

export interface SpanRecord {
  readonly traceId: string // 32 hex chars
  readonly spanId: string // 16 hex chars
  readonly parentSpanId?: string
  readonly name: string
  readonly kind: number // 1=INTERNAL 3=CLIENT
  readonly startTimeUnixNano: bigint
  readonly endTimeUnixNano: bigint
  readonly attributes: ReadonlyArray<readonly [string, AttrValue]>
  readonly status: { readonly code: number; readonly message?: string } // 1=OK 2=ERROR
}

function varint(n: number): Buffer {
  const bytes: number[] = []
  while (true) {
    const b = n & 0x7f
    n = Math.floor(n / 128) // >>> 7 breaks above 2^32; use division
    bytes.push(n ? b | 0x80 : b)
    if (!n) return Buffer.from(bytes)
  }
}

function tag(field: number, wire: number): Buffer {
  return varint((field << 3) | wire)
}

/** length-delimited field */
function ld(field: number, payload: Buffer): Buffer {
  return Buffer.concat([tag(field, 2), varint(payload.length), payload])
}

function s(field: number, value: string): Buffer {
  return ld(field, Buffer.from(value, "utf-8"))
}

function varintField(field: number, value: number): Buffer {
  return Buffer.concat([tag(field, 0), varint(value)])
}

function fixed64(field: number, value: bigint): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(value)
  return Buffer.concat([tag(field, 1), buf])
}

function double(field: number, value: number): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeDoubleLE(value)
  return Buffer.concat([tag(field, 1), buf])
}

/** KeyValue{key=1, value=2}; AnyValue: string=1, bool=2 varint, int64=3 varint, double=4 fixed64 */
function kv(key: string, value: AttrValue): Buffer {
  let inner: Buffer
  if (typeof value === "string") inner = s(1, value)
  else if (typeof value === "boolean") inner = varintField(2, value ? 1 : 0)
  else if (Number.isInteger(value)) inner = varintField(3, value)
  else inner = double(4, value)
  return Buffer.concat([s(1, key), ld(2, inner)])
}

/**
 * Span: trace_id=1, span_id=2, parent_span_id=4, name=5, kind=6,
 * start=7, end=8 fixed64, attributes=9 repeated, status=15
 */
function spanMessage(span: SpanRecord): Buffer {
  const parts: Buffer[] = [
    ld(1, Buffer.from(span.traceId, "hex")),
    ld(2, Buffer.from(span.spanId, "hex")),
  ]
  if (span.parentSpanId) parts.push(ld(4, Buffer.from(span.parentSpanId, "hex")))
  parts.push(s(5, span.name))
  parts.push(varintField(6, span.kind))
  parts.push(fixed64(7, span.startTimeUnixNano))
  parts.push(fixed64(8, span.endTimeUnixNano))
  for (const [k, v] of span.attributes) parts.push(ld(9, kv(k, v)))
  const status = span.status
  if (status.code !== 1 || status.message) {
    const inner = Buffer.concat([
      status.message ? s(2, status.message) : Buffer.alloc(0),
      varintField(3, status.code),
    ])
    parts.push(ld(15, inner))
  }
  return Buffer.concat(parts)
}

export interface OtlpOptions {
  /** Project name (openinference.project.name resource attribute, OpenInference convention) */
  readonly project?: string
  /** Extra request headers (auth etc.); never overrides content-type */
  readonly headers?: Record<string, string>
  /** Custom attributes merged into the resource block (mirrors OTEL_RESOURCE_ATTRIBUTES; builtin keys win on conflicts) */
  readonly resourceAttributes?: Record<string, string>
  /** Per-request timeout in ms, default 30s (a half-open peer must not hang the pump/unload path) */
  readonly timeoutMs?: number
}

export function buildBody(spans: readonly SpanRecord[], options: OtlpOptions = {}): Buffer {
  const builtin = new Map<string, AttrValue>([["service.name", "opencode-genai-obs"]])
  if (options.project) builtin.set("openinference.project.name", options.project)
  for (const [key, value] of Object.entries(options.resourceAttributes ?? {})) {
    if (!builtin.has(key)) builtin.set(key, value) // builtin keys win (Claude Code semantics)
  }
  const resource = Buffer.concat([...builtin].map(([k, v]) => ld(1, kv(k, v))))
  const scope = Buffer.concat([s(1, "opencode-genai-obs"), s(2, "0.1.0")])
  const scopeSpans = Buffer.concat([ld(1, scope), ...spans.map((span) => ld(2, spanMessage(span)))])
  const resourceSpans = Buffer.concat([ld(1, resource), ld(2, scopeSpans)])
  return ld(1, resourceSpans) // ExportTraceServiceRequest.resource_spans = 1
}

/** POST a batch of spans to an OTLP/HTTP backend. Throws on failure (the caller owns the retry queue). */
export async function postSpans(
  spans: readonly SpanRecord[],
  endpoint: string,
  options: OtlpOptions = {},
): Promise<void> {
  const body = buildBody(spans, options)
  // Custom headers first, built-ins last so content-type cannot be clobbered; the
  // project semantic rides the openinference.project.name resource attribute — no
  // backend-specific headers are ever sent
  const headers: Record<string, string> = {
    ...(options.headers ?? {}),
    "content-type": "application/x-protobuf",
  }
  const response = await fetch(endpoint.replace(/\/+$/, "") + "/v1/traces", {
    method: "POST",
    headers,
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  })
  if (response.status !== 200) {
    const text = await response.text().catch(() => "")
    throw new Error(`OTLP export failed: ${response.status} ${text.slice(0, 200)}`)
  }
}
