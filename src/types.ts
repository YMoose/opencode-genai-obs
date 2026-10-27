/**
 * 发给 LLM 的原始请求体（wire body）的一行 JSONL 记录。
 * 字段与 obsystem/otel-span-exportor/RAW-REQUESTS.md 对齐。
 */
export interface WireRecord {
  /** 版本号，未来 schema 变更时 +1 */
  readonly v: 1
  /** ISO8601 毫秒 */
  readonly ts: string
  /** 进程级单调递增序号，同会话内排序用 */
  readonly seq: number
  /** 从哪个 hook 拿到的 */
  readonly hook: "ws.send" | "http.request"
  /** opencode 会话 id */
  readonly sessionID: string
  /** agent id（如 "sisyphus"） */
  readonly agent: string
  /** 模型引用 { providerID, id } */
  readonly model: { readonly providerID: string; readonly id: string }
  /** 请求分类：primary | compaction | title | generate */
  readonly kind: string
  /** 完整 wire body：ws.send 的 frame 字符串，或 http.request 的 body 文本 */
  readonly frame: string
}

/** hook 事件的最小公共形状（v2 SessionHooks 里 ws.send / http.request 的参数） */
export interface WireHookEvent {
  readonly sessionID: string
  readonly agent: string
  readonly model: { readonly providerID: string; readonly modelID?: string; readonly id?: string }
  readonly kind: string
}
