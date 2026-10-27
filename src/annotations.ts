/**
 * Session annotations 实时写入（Phase 2.5，可选增强）。
 *
 * 走 Phoenix 兼容后端的 POST /v1/session_annotations?sync=true（project/title
 * 两条 CODE annotation，渲染成 Sessions 表的列）。这是后端专属 REST API 而非
 * OTLP 标准 —— 项目定位不绑定平台，因此由 tracing.annotations.enabled 控制
 * （默认 true 以兼容既有部署；非 Phoenix 后端建议关闭）。
 * DO_UPDATE upsert 语义 —— title 改名后重写即可刷新。
 *
 * 只给根会话打：Phoenix 类后端每条 trace 只按根 span 的 session.id 建
 * ProjectSession，subagent 会话没有对应记录，打了会整批 404（sync.py 同款边界）。
 *
 * 失败只告警不中断：span 入库是异步队列，annotation 请求可能因 session 尚未
 * 建出 404 —— 重试 3 次（间隔 2s / 4s）。过期仍败则静默放弃，离线 sync.py 兜底。
 */

export interface SessionAnnotationFields {
  /** Sessions 表 "title" 列 */
  readonly title?: string
  /** Sessions 表 "project" 列（= 会话目录 basename） */
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
  /** fire-and-forget 安全：内部捕获所有错误，只会 log 不会 throw */
  readonly annotate: (sessionID: string, fields: SessionAnnotationFields) => Promise<void>
}

export function createAnnotator(
  options: {
    readonly endpoint: string
    readonly headers?: Record<string, string>
    /** 单次请求超时毫秒数，默认 30s */
    readonly timeoutMs?: number
    /** 重试基础间隔毫秒（第 n 次失败后等 n×base），默认 2s */
    readonly retryDelayMs?: number
  },
  log: (msg: string, data?: unknown) => void,
): Annotator {
  const url = options.endpoint.replace(/\/+$/, "") + "/v1/session_annotations?sync=true"
  // 自定义头在前，内置头最后覆盖（防 content-type 被冲掉）
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
