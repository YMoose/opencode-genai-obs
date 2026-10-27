/**
 * OTLP/HTTP protobuf 编码器 + POST —— otlp.py 的 TS 移植，无外部依赖。
 * 编码 opentelemetry/proto/collector/trace/v1 ExportTraceServiceRequest 的
 * 稳定子集：Resource/Scope/Span/KeyValue/AnyValue/Status。
 * Phoenix /v1/traces 只收 application/x-protobuf（已验证）。
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
    n = Math.floor(n / 128) // >>> 7 对 >2^32 失效，用除法
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
  /** Phoenix project 名（openinference.project.name） */
  readonly project?: string
  /** 额外请求头（认证等）；不覆盖 content-type/x-project-name */
  readonly headers?: Record<string, string>
  /** 并入 resource 块的自定义属性（对齐 OTEL_RESOURCE_ATTRIBUTES；与内置键冲突时保留内置值） */
  readonly resourceAttributes?: Record<string, string>
  /** 单次请求超时毫秒数，默认 30s（防对端半开挂死 pump/卸载流程） */
  readonly timeoutMs?: number
}

export function buildBody(spans: readonly SpanRecord[], options: OtlpOptions = {}): Buffer {
  const builtin = new Map<string, AttrValue>([["service.name", "opencode-genai-obs"]])
  if (options.project) builtin.set("openinference.project.name", options.project)
  for (const [key, value] of Object.entries(options.resourceAttributes ?? {})) {
    if (!builtin.has(key)) builtin.set(key, value) // 内置键不覆盖（对齐 Claude Code 语义）
  }
  const resource = Buffer.concat([...builtin].map(([k, v]) => ld(1, kv(k, v))))
  const scope = Buffer.concat([s(1, "opencode-genai-obs"), s(2, "0.1.0")])
  const scopeSpans = Buffer.concat([ld(1, scope), ...spans.map((span) => ld(2, spanMessage(span)))])
  const resourceSpans = Buffer.concat([ld(1, resource), ld(2, scopeSpans)])
  return ld(1, resourceSpans) // ExportTraceServiceRequest.resource_spans = 1
}

/** POST 一批 span 到 Phoenix。失败抛错（调用方负责重试队列）。 */
export async function postSpans(
  spans: readonly SpanRecord[],
  endpoint: string,
  options: OtlpOptions = {},
): Promise<void> {
  const body = buildBody(spans, options)
  // 自定义头在前，内置头最后覆盖（防 content-type/x-project-name 被冲掉）
  const headers: Record<string, string> = {
    ...(options.headers ?? {}),
    "content-type": "application/x-protobuf",
  }
  if (options.project) headers["x-project-name"] = options.project
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
