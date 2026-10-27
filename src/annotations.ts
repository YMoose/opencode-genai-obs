/**
 * Phoenix session annotations 实时写入（Phase 2.5）。
 *
 * 对应 sync.py 的 annotate_sessions：POST /v1/session_annotations?sync=true，
 * project/title 两条 CODE annotation，Phoenix 把它们渲染成 Sessions 表的列。
 * DO_UPDATE upsert 语义 —— title 改名后重写即可刷新。
 *
 * 只给根会话打：Phoenix 每条 trace 只按根 span 的 session.id 建 ProjectSession，
 * subagent 会话没有对应记录，打了会整批 404（sync.py 同款边界）。
 *
 * 失败只告警不中断：Phoenix 的 OTLP span 入库是异步队列，annotation 请求可能因
 * session 尚未建出 404 —— 重试 3 次（间隔 2s / 4s）。过期仍败则静默放弃，
 * 离线 sync.py 兜底。
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
  options: { readonly endpoint: string; readonly headers?: Record<string, string> },
  log: (msg: string, data?: unknown) => void,
): Annotator {
  const url = options.endpoint.replace(/\/+$/, "") + "/v1/session_annotations?sync=true"
  const headers = { "content-type": "application/json", ...(options.headers ?? {}) }
  headers["content-type"] = "application/json" // 内置键防覆盖

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
          await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt))
        }
      }
    },
  }
}
