/**
 * 配置加载：~/.config/opencode/ocg-tracing.json（JSONC，支持注释）。
 *
 * 三级优先级（高 → 低），对齐 Claude Code monitoring-usage 文档的 OTEL env 惯例：
 * 1. 标准 OTEL 环境变量（组织级统一部署走这条，不用改每个人的配置文件）：
 *    - OTEL_EXPORTER_OTLP_TRACES_ENDPOINT，回落 OTEL_EXPORTER_OTLP_ENDPOINT
 *      → tracing.endpoint（值可带 /v1/traces 尾路径，加载时剥掉）
 *    - OTEL_EXPORTER_OTLP_TRACES_HEADERS + OTEL_EXPORTER_OTLP_HEADERS（合并）
 *      → tracing.headers（"k1=v1,k2=v2" 格式）
 *    - OTEL_RESOURCE_ATTRIBUTES → tracing.resourceAttributes（同格式）
 * 2. JSONC 配置文件：OCG_TRACING_CONFIG > OPENCODE_CONFIG_DIR/ocg-tracing.json
 *    > XDG_CONFIG_HOME/opencode/ocg-tracing.json > ~/.config/opencode/ocg-tracing.json
 * 3. 内置默认
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

export interface TracingConfig {
  /** 默认 true：事件流 → OTLP span → Phoenix */
  readonly enabled: boolean
  /** Phoenix OTLP HTTP endpoint，默认 http://localhost:6006 */
  readonly endpoint: string
  /** Phoenix project 名（openinference.project.name），默认 "opencode" */
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
}

export interface Config {
  /** 总开关，默认 true。false 时插件什么都不做 */
  readonly enabled: boolean
  readonly wire: WireConfig
  readonly tracing: TracingConfig
}

export interface ConfigWarning {
  readonly kind: "invalid-json" | "read-error" | "unknown-key" | "bad-env"
  readonly message: string
}

function configSearchDir(): string {
  if (process.env.OCG_TRACING_CONFIG) return dirname(process.env.OCG_TRACING_CONFIG)
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

function resolveGates(content: boolean, raw: Record<string, unknown>): ContentGates {
  return {
    userPrompts: (raw.userPrompts as boolean | undefined) ?? true,
    assistantResponses: (raw.assistantResponses as boolean | undefined) ?? true,
    toolDetails: (raw.toolDetails as boolean | undefined) ?? content,
    toolContent: (raw.toolContent as boolean | undefined) ?? content,
    wireBody: (raw.wireBody as boolean | undefined) ?? true,
  }
}

export function loadConfig(log: (msg: string, data?: unknown) => void): { config: Config; warnings: ConfigWarning[] } {
  const warnings: ConfigWarning[] = []
  const configPath = process.env.OCG_TRACING_CONFIG ?? join(configSearchDir(), "ocg-tracing.json")

  const defaults: Config = {
    enabled: true,
    wire: {
      enabled: false,
      directory: join(dataDir(), "raw-requests"),
    },
    tracing: {
      enabled: true,
      endpoint: "http://localhost:6006",
      project: "opencode",
      headers: {},
      content: true,
      contentGates: resolveGates(true, {}),
      contentMaxLength: 0,
      resourceAttributes: {},
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
        // 未知 key 警告（不拒绝，只提示）
        const knownKeys = new Set(["enabled", "wire", "tracing"])
        for (const key of Object.keys(parsed)) {
          if (!knownKeys.has(key)) {
            warnings.push({ kind: "unknown-key", message: `unknown key "${key}" in ${configPath}` })
          }
        }

        const wireRaw = (parsed.wire ?? {}) as Record<string, unknown>
        const tracingRaw = (parsed.tracing ?? {}) as Record<string, unknown>
        const content = (tracingRaw.content as boolean | undefined) ?? defaults.tracing.content
        fileConfig = {
          enabled: (parsed.enabled as boolean | undefined) ?? defaults.enabled,
          wire: {
            enabled: (wireRaw.enabled as boolean | undefined) ?? defaults.wire.enabled,
            directory: (wireRaw.directory as string | undefined) ?? defaults.wire.directory,
          },
          tracing: {
            enabled: (tracingRaw.enabled as boolean | undefined) ?? defaults.tracing.enabled,
            endpoint: (tracingRaw.endpoint as string | undefined) ?? defaults.tracing.endpoint,
            project: (tracingRaw.project as string | undefined) ?? defaults.tracing.project,
            headers: (tracingRaw.headers as Record<string, string> | undefined) ?? {},
            content,
            contentGates: resolveGates(content, (tracingRaw.contentGates ?? {}) as Record<string, unknown>),
            contentMaxLength: (tracingRaw.contentMaxLength as number | undefined) ?? defaults.tracing.contentMaxLength,
            resourceAttributes: (tracingRaw.resourceAttributes as Record<string, string> | undefined) ?? {},
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
