/**
 * 配置加载：~/.config/opencode/ocg-obs.json（JSONC，支持注释）。
 *
 * 三级优先级（高 → 低），对齐 Claude Code monitoring-usage 文档的 OTEL env 惯例：
 * 1. 标准 OTEL 环境变量（组织级统一部署走这条，不用改每个人的配置文件）：
 *    - OTEL_EXPORTER_OTLP_TRACES_ENDPOINT，回落 OTEL_EXPORTER_OTLP_ENDPOINT
 *      → tracing.endpoint（值可带 /v1/traces 尾路径，加载时剥掉）
 *    - OTEL_EXPORTER_OTLP_TRACES_HEADERS + OTEL_EXPORTER_OTLP_HEADERS（合并）
 *      → tracing.headers（"k1=v1,k2=v2" 格式）
 *    - OTEL_RESOURCE_ATTRIBUTES → tracing.resourceAttributes（同格式）
 * 2. JSONC 配置文件：OCG_OBS_CONFIG > OPENCODE_CONFIG_DIR/ocg-obs.json
 *    > XDG_CONFIG_HOME/opencode/ocg-obs.json > ~/.config/opencode/ocg-obs.json
 * 3. 内置默认
 *
 * 所有文件字段做类型校验：类型不匹配（如 "false"/"500" 这类 JSON 笔误）告警并回落默认，
 * 不再静默按 JS 真值性/隐式转换生效。根级与 wire/tracing/contentGates 层的未知 key 均告警。
 */
import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"

export interface WireConfig {
  /** 默认 false：wire body 含完整 system prompt/历史/tools，隐私+磁盘双敏感 */
  readonly enabled: boolean
  /** 默认 <dataDir>/raw-requests/ */
  readonly directory: string
}

/**
 * 细粒度内容门（对齐 Claude Code 的 OTEL_LOG_USER_PROMPTS / TOOL_DETAILS / TOOL_CONTENT）。
 * `content` 是粗开关：false 时 toolDetails/toolContent 默认关；其余域默认开，
 * 可各自单独覆盖。wireBody 独立 —— 只落盘不进 span 的隐私档靠它。
 */
export interface ContentGates {
  /** 轮根 span input.value（该轮用户消息），默认 true */
  readonly userPrompts: boolean
  /** 轮根 output.value（最后一答）、chat span output.value、gen_ai.output.messages、opencode.reasoning，默认 true */
  readonly assistantResponses: boolean
  /** gen_ai.tool.call.arguments + tool span input.value，默认跟随 content */
  readonly toolDetails: boolean
  /** gen_ai.tool.call.result + tool span output.value，默认跟随 content */
  readonly toolContent: boolean
  /** wire body 进 chat span input.value/input.mime_type，默认 true（不挂 span 时 JSONL 照落） */
  readonly wireBody: boolean
}

export interface AnnotationsConfig {
  /**
   * 默认 true：session.created/renamed → 实时 project/title annotation。
   * 走 Phoenix 兼容后端的 /v1/session_annotations REST API（非 OTLP 标准，
   * 其他后端接不到会 404），非 Phoenix 后端建议显式关闭。
   */
  readonly enabled: boolean
}

export interface TracingConfig {
  /** 默认 true：事件流 → OTLP span → OTLP/HTTP 后端 */
  readonly enabled: boolean
  /** OTLP/HTTP endpoint（任意兼容后端：OTel Collector / Phoenix / SigNoz …），默认 http://localhost:4318 */
  readonly endpoint: string
  /** project 名（openinference.project.name resource 属性，OpenInference 约定），默认 "opencode" */
  readonly project: string
  /** 额外请求头（认证等），同时用于 /v1/traces 与 /v1/session_annotations */
  readonly headers: Record<string, string>
  /** 粗内容开关，默认 true。false → toolDetails/toolContent 默认关（可被 contentGates 单独拉回） */
  readonly content: boolean
  readonly contentGates: ContentGates
  /**
   * 内容类属性最大长度（字符），默认 0 = 不截断（对齐
   * CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH 语义，那个默认 60KB）。
   * 截断时追加 `[TRUNCATED]` 标记并给 OpenInference 键补 `<key>_truncated/_original_length` 属性。
   */
  readonly contentMaxLength: number
  /** 并入 OTLP resource 块的自定义属性（host.name / team 等；与内置键冲突时保留内置值） */
  readonly resourceAttributes: Record<string, string>
  readonly annotations: AnnotationsConfig
}

export interface Config {
  /** 总开关，默认 true。false 时插件什么都不做 */
  readonly enabled: boolean
  readonly wire: WireConfig
  readonly tracing: TracingConfig
}

export interface ConfigWarning {
  readonly kind: "invalid-json" | "read-error" | "unknown-key" | "bad-env" | "bad-type"
  readonly message: string
}

const ROOT_KEYS = new Set(["enabled", "wire", "tracing"])
const WIRE_KEYS = new Set(["enabled", "directory"])
const TRACING_KEYS = new Set([
  "enabled",
  "endpoint",
  "project",
  "headers",
  "content",
  "contentGates",
  "contentMaxLength",
  "resourceAttributes",
  "annotations",
])
const GATE_KEYS = new Set(["userPrompts", "assistantResponses", "toolDetails", "toolContent", "wireBody"])
const ANNOTATION_KEYS = new Set(["enabled"])

// ---------------------------------------------------------------------------
// 类型校验 + 默认值回落
// ---------------------------------------------------------------------------

function boolField(value: unknown, path: string, fallback: boolean, warnings: ConfigWarning[]): boolean {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") {
    warnings.push({ kind: "bad-type", message: `${path}: expected boolean, got ${JSON.stringify(value)}; using ${fallback}` })
    return fallback
  }
  return value
}

function stringField(value: unknown, path: string, fallback: string, warnings: ConfigWarning[]): string {
  if (value === undefined) return fallback
  if (typeof value !== "string") {
    warnings.push({ kind: "bad-type", message: `${path}: expected string, got ${JSON.stringify(value)}; using default` })
    return fallback
  }
  return value
}

function intField(value: unknown, path: string, fallback: number, warnings: ConfigWarning[]): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    warnings.push({ kind: "bad-type", message: `${path}: expected non-negative integer, got ${JSON.stringify(value)}; using ${fallback}` })
    return fallback
  }
  return value
}

/** 字符串字典：值非 string 的键跳过并告警 */
function recordField(value: unknown, path: string, warnings: ConfigWarning[]): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push({ kind: "bad-type", message: `${path}: expected object, got ${Array.isArray(value) ? "array" : typeof value}; using {}` })
    return {}
  }
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "string") {
      warnings.push({ kind: "bad-type", message: `${path}.${key}: expected string, got ${typeof item}; skipped` })
      continue
    }
    out[key] = item
  }
  return out
}

/** 取配置节：null/缺失 → {}；非对象 → 告警并按 {} 处理 */
function section(value: unknown, path: string, warnings: ConfigWarning[]): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push({ kind: "bad-type", message: `${path}: expected object; section ignored` })
    return {}
  }
  return value as Record<string, unknown>
}

function unknownKeys(raw: Record<string, unknown>, known: ReadonlySet<string>, path: string, configPath: string, warnings: ConfigWarning[]): void {
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      warnings.push({ kind: "unknown-key", message: `unknown key "${path ? `${path}.${key}` : key}" in ${configPath}` })
    }
  }
}

function configSearchDir(): string {
  if (process.env.OCG_OBS_CONFIG) return dirname(process.env.OCG_OBS_CONFIG)
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "opencode")
  return join(homedir(), ".config", "opencode")
}

function dataDir(): string {
  return join(homedir(), ".local", "share", "opencode")
}

/** 解析 OTEL 惯例的 "k1=v1,k2=v2" 头/资源属性格式；坏对跳过并 warn */
function parseKvList(raw: string | undefined, envName: string, warnings: ConfigWarning[]): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw) return out
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=")
    if (eq <= 0) {
      warnings.push({ kind: "bad-env", message: `${envName}: skipping malformed pair "${pair.trim()}"` })
      continue
    }
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
  }
  return out
}

/** endpoint 归一化：剥尾斜杠，并剥掉用户照抄 OTEL 文档带上的 /v1/traces 尾路径（我们发送时自己拼） */
function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "").replace(/\/v1\/traces$/, "")
}

function resolveGates(content: boolean, raw: Record<string, unknown>, warnings: ConfigWarning[]): ContentGates {
  return {
    userPrompts: boolField(raw.userPrompts, "tracing.contentGates.userPrompts", true, warnings),
    assistantResponses: boolField(raw.assistantResponses, "tracing.contentGates.assistantResponses", true, warnings),
    toolDetails: boolField(raw.toolDetails, "tracing.contentGates.toolDetails", content, warnings),
    toolContent: boolField(raw.toolContent, "tracing.contentGates.toolContent", content, warnings),
    wireBody: boolField(raw.wireBody, "tracing.contentGates.wireBody", true, warnings),
  }
}

export function loadConfig(log: (msg: string, data?: unknown) => void): { config: Config; warnings: ConfigWarning[] } {
  const warnings: ConfigWarning[] = []
  const configPath = process.env.OCG_OBS_CONFIG ?? join(configSearchDir(), "ocg-obs.json")

  const defaults: Config = {
    enabled: true,
    wire: {
      enabled: false,
      directory: join(dataDir(), "raw-requests"),
    },
    tracing: {
      enabled: true,
      endpoint: "http://localhost:4318",
      project: "opencode",
      headers: {},
      content: true,
      contentGates: resolveGates(true, {}, warnings),
      contentMaxLength: 0,
      resourceAttributes: {},
      annotations: { enabled: true },
    },
  }

  // --- 文件层 ---
  let fileConfig: Config = defaults
  if (!existsSync(configPath)) {
    log("no config file, using defaults", { path: configPath })
  } else {
    let raw: string
    try {
      raw = readFileSync(configPath, "utf-8").replace(/^\uFEFF/, "") // BOM
      const parseErrors: ParseError[] = []
      // jsonc-parser：注释/尾逗号都合法，字符串里的 // 不会被误伤（原手写 strip 的坑）
      const parsed = parseJsonc(raw, parseErrors, { allowTrailingComma: true }) as Record<string, unknown>
      if (parseErrors.length > 0 || !parsed || typeof parsed !== "object") {
        warnings.push({ kind: "invalid-json", message: `invalid JSON in ${configPath}: ${parseErrors.length} parse error(s)` })
      } else {
        unknownKeys(parsed, ROOT_KEYS, "", configPath, warnings)

        const wireRaw = section(parsed.wire, "wire", warnings)
        const tracingRaw = section(parsed.tracing, "tracing", warnings)
        unknownKeys(wireRaw, WIRE_KEYS, "wire", configPath, warnings)
        unknownKeys(tracingRaw, TRACING_KEYS, "tracing", configPath, warnings)

        const gatesRaw = section(tracingRaw.contentGates, "tracing.contentGates", warnings)
        unknownKeys(gatesRaw, GATE_KEYS, "tracing.contentGates", configPath, warnings)
        const annotationsRaw = section(tracingRaw.annotations, "tracing.annotations", warnings)
        unknownKeys(annotationsRaw, ANNOTATION_KEYS, "tracing.annotations", configPath, warnings)

        const content = boolField(tracingRaw.content, "tracing.content", defaults.tracing.content, warnings)
        fileConfig = {
          enabled: boolField(parsed.enabled, "enabled", defaults.enabled, warnings),
          wire: {
            enabled: boolField(wireRaw.enabled, "wire.enabled", defaults.wire.enabled, warnings),
            directory: stringField(wireRaw.directory, "wire.directory", defaults.wire.directory, warnings),
          },
          tracing: {
            enabled: boolField(tracingRaw.enabled, "tracing.enabled", defaults.tracing.enabled, warnings),
            endpoint: stringField(tracingRaw.endpoint, "tracing.endpoint", defaults.tracing.endpoint, warnings),
            project: stringField(tracingRaw.project, "tracing.project", defaults.tracing.project, warnings),
            headers: recordField(tracingRaw.headers, "tracing.headers", warnings),
            content,
            contentGates: resolveGates(content, gatesRaw, warnings),
            contentMaxLength: intField(tracingRaw.contentMaxLength, "tracing.contentMaxLength", defaults.tracing.contentMaxLength, warnings),
            resourceAttributes: recordField(tracingRaw.resourceAttributes, "tracing.resourceAttributes", warnings),
            annotations: {
              enabled: boolField(annotationsRaw.enabled, "tracing.annotations.enabled", defaults.tracing.annotations.enabled, warnings),
            },
          },
        }
        log("loaded config", { path: configPath, wireEnabled: fileConfig.wire.enabled })
      }
    } catch (error) {
      warnings.push({ kind: "read-error", message: `cannot read ${configPath}: ${error}` })
    }
  }

  // --- 环境变量层（覆盖文件层；对齐 OTEL_EXPORTER_OTLP_* 惯例） ---
  const envEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  // 头合并：文件 < 通用 env < traces 专用 env（对齐 Claude Code env 覆盖文件的惯例）
  const envHeaders = {
    ...parseKvList(process.env.OTEL_EXPORTER_OTLP_HEADERS, "OTEL_EXPORTER_OTLP_HEADERS", warnings),
    ...parseKvList(process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS, "OTEL_EXPORTER_OTLP_TRACES_HEADERS", warnings),
  }
  // 资源属性：文件 < env（同惯例）
  const envResource = parseKvList(process.env.OTEL_RESOURCE_ATTRIBUTES, "OTEL_RESOURCE_ATTRIBUTES", warnings)

  const config: Config = {
    ...fileConfig,
    tracing: {
      ...fileConfig.tracing,
      endpoint: normalizeEndpoint(envEndpoint ?? fileConfig.tracing.endpoint),
      headers: { ...fileConfig.tracing.headers, ...envHeaders },
      resourceAttributes: { ...fileConfig.tracing.resourceAttributes, ...envResource },
    },
  }

  return { config, warnings }
}
