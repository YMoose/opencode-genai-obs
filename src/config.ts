/**
 * @fileoverview Config loading: ~/.config/opencode/ocg-obs.json (JSONC, comments allowed).
 *
 * Three precedence levels (high → low), aligned with the OTEL env conventions of the
 * Claude Code monitoring-usage docs:
 * 1. Standard OTEL environment variables (org-wide rollout without touching per-user
 *    config files):
 *    - OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, falling back to OTEL_EXPORTER_OTLP_ENDPOINT
 *      → tracing.endpoint (a trailing /v1/traces path is stripped at load time)
 *    - OTEL_EXPORTER_OTLP_TRACES_HEADERS + OTEL_EXPORTER_OTLP_HEADERS (merged)
 *      → tracing.headers ("k1=v1,k2=v2" format)
 *    - OTEL_RESOURCE_ATTRIBUTES → tracing.resourceAttributes (same format)
 * 2. JSONC config file: OCG_OBS_CONFIG > OPENCODE_CONFIG_DIR/ocg-obs.json
 *    > XDG_CONFIG_HOME/opencode/ocg-obs.json > ~/.config/opencode/ocg-obs.json
 * 3. Built-in defaults
 *
 * Every file field is type-checked: a mismatch (e.g. a "false"/"500" JSON typo) warns
 * and falls back to the default instead of silently passing JS truthiness or implicit
 * coercion. Unknown keys are reported at the root and wire/tracing/contentGates levels.
 */
import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"

export interface WireConfig {
  /** Default false: wire bodies contain the full system prompt/history/tools — sensitive for both privacy and disk */
  readonly enabled: boolean
  /** Default: <dataDir>/raw-requests/ */
  readonly directory: string
  /**
   * Disk-only frame cap, default -1 = full frame. 0 = metadata-only records (frame content
   * dropped); N>0 = first N bytes on disk plus a "[TRUNCATED]" suffix, marked
   * truncated=true + frameBytes=original size, cut at a UTF-8 character boundary. The
   * pending/span path always receives the full frame (spans have their own
   * contentGates.wireBody + contentMaxLength controls).
   */
  readonly maxFrameBytes: number
}

/**
 * Fine-grained content gates (mirroring Claude Code's OTEL_LOG_USER_PROMPTS /
 * TOOL_DETAILS / TOOL_CONTENT). `content` is the coarse switch: when false,
 * toolDetails/toolContent default off; the other domains default on and can be
 * overridden individually. wireBody is separate — it is the privacy tier for
 * "write to disk but keep out of spans".
 */
export interface ContentGates {
  /** Root-span input.value (the turn's user message), default true */
  readonly userPrompts: boolean
  /** Root output.value (final answer), chat-span output.value, gen_ai.output.messages, opencode.reasoning; default true */
  readonly assistantResponses: boolean
  /** gen_ai.tool.call.arguments + tool-span input.value, defaults to follow content */
  readonly toolDetails: boolean
  /** gen_ai.tool.call.result + tool-span output.value, defaults to follow content */
  readonly toolContent: boolean
  /** Wire body into chat-span input.value/input.mime_type, default true (JSONL is still written when not attached to a span) */
  readonly wireBody: boolean
}

export interface AnnotationsConfig {
  /**
   * Default true: session.created/renamed → real-time project/title annotation via the
   * Phoenix-compatible /v1/session_annotations REST API (not an OTLP standard; other
   * backends will 404). Non-Phoenix backends should disable it explicitly.
   */
  readonly enabled: boolean
}

export interface TracingConfig {
  /** Default true: event stream → OTLP spans → OTLP/HTTP backend */
  readonly enabled: boolean
  /** OTLP/HTTP endpoint (any compatible backend: OTel Collector / Phoenix / SigNoz …), default http://localhost:4318 */
  readonly endpoint: string
  /** Project name (openinference.project.name resource attribute, OpenInference convention), default "opencode" */
  readonly project: string
  /** Extra request headers (auth etc.); shared by /v1/traces and /v1/session_annotations */
  readonly headers: Record<string, string>
  /** Coarse content switch, default true. false → toolDetails/toolContent default off (re-enable individually via contentGates) */
  readonly content: boolean
  readonly contentGates: ContentGates
  /**
   * Max length (chars) of content attributes; three-state semantics aligned with wire.maxFrameBytes:
   * - -1 (default): no truncation
   * -  0: metadata-only — the attribute value is omitted, only `<key>_original_length`
   *       is emitted when the span provides one (mirrors OTEL_LOG_*=0 semantics)
   * -  N > 0: cut at N UTF-16 code units with a `[TRUNCATED original_length=N]` marker
   *          and record `<key>_original_length`
   * (The CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH default of 60 KB is a good N if you want a cap.)
   */
  readonly contentMaxLength: number
  /** Custom attributes merged into the OTLP resource block (host.name / team etc.; builtin keys win on conflicts) */
  readonly resourceAttributes: Record<string, string>
  readonly annotations: AnnotationsConfig
}

export interface Config {
  /** Master switch, default true. When false the plugin does nothing */
  readonly enabled: boolean
  readonly wire: WireConfig
  readonly tracing: TracingConfig
}

export interface ConfigWarning {
  readonly kind: "invalid-json" | "read-error" | "unknown-key" | "bad-env" | "bad-type"
  readonly message: string
}

const ROOT_KEYS = new Set(["enabled", "wire", "tracing"])
const WIRE_KEYS = new Set(["enabled", "directory", "maxFrameBytes"])
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
// Type validation + default fallback
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

function intField(value: unknown, path: string, fallback: number, warnings: ConfigWarning[], min = 0): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    warnings.push({ kind: "bad-type", message: `${path}: expected integer >= ${min}, got ${JSON.stringify(value)}; using ${fallback}` })
    return fallback
  }
  return value
}

/** String record: non-string values are skipped with a warning */
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

/** Read a config section: null/missing → {}; non-object → warn and treat as {} */
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

/** Percent-decode with a raw fallback: the OTLP exporter spec uses the W3C Baggage format, so
 * "Bearer%20token" must arrive decoded at the collector; malformed sequences ("100%", "abc%zz") stay as-is */
function decodePair(component: string): string {
  try {
    return decodeURIComponent(component)
  } catch {
    return component
  }
}

/** Parse the OTEL-style "k1=v1,k2=v2" headers/resource-attributes format; malformed pairs are skipped with a warning */
function parseKvList(raw: string | undefined, envName: string, warnings: ConfigWarning[]): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw) return out
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=")
    if (eq <= 0) {
      warnings.push({ kind: "bad-env", message: `${envName}: skipping malformed pair "${pair.trim()}"` })
      continue
    }
    out[decodePair(pair.slice(0, eq).trim())] = decodePair(pair.slice(eq + 1).trim())
  }
  return out
}

/** Endpoint normalization: strip trailing slashes and the /v1/traces suffix users copy from OTEL docs (we append the path ourselves when sending) */
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
      maxFrameBytes: -1,
    },
    tracing: {
      enabled: true,
      endpoint: "http://localhost:4318",
      project: "opencode",
      headers: {},
      content: true,
      contentGates: resolveGates(true, {}, warnings),
      contentMaxLength: -1,
      resourceAttributes: {},
      annotations: { enabled: true },
    },
  }

  // --- File layer ---
  let fileConfig: Config = defaults
  if (!existsSync(configPath)) {
    log("no config file, using defaults", { path: configPath })
  } else {
    let raw: string
    try {
      raw = readFileSync(configPath, "utf-8").replace(/^\uFEFF/, "") // strip BOM
      const parseErrors: ParseError[] = []
      // jsonc-parser: comments/trailing commas are legal, and // inside strings is left
      // alone (a pitfall of the old hand-rolled stripper)
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
            maxFrameBytes: intField(wireRaw.maxFrameBytes, "wire.maxFrameBytes", defaults.wire.maxFrameBytes, warnings, -1),
          },
          tracing: {
            enabled: boolField(tracingRaw.enabled, "tracing.enabled", defaults.tracing.enabled, warnings),
            endpoint: stringField(tracingRaw.endpoint, "tracing.endpoint", defaults.tracing.endpoint, warnings),
            project: stringField(tracingRaw.project, "tracing.project", defaults.tracing.project, warnings),
            headers: recordField(tracingRaw.headers, "tracing.headers", warnings),
            content,
            contentGates: resolveGates(content, gatesRaw, warnings),
            contentMaxLength: intField(tracingRaw.contentMaxLength, "tracing.contentMaxLength", defaults.tracing.contentMaxLength, warnings, -1),
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

  // --- Env layer (overrides the file layer; aligned with OTEL_EXPORTER_OTLP_* conventions) ---
  const envEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  // Header merge: file < generic env < traces-specific env (Claude Code's env-over-file convention)
  const envHeaders = {
    ...parseKvList(process.env.OTEL_EXPORTER_OTLP_HEADERS, "OTEL_EXPORTER_OTLP_HEADERS", warnings),
    ...parseKvList(process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS, "OTEL_EXPORTER_OTLP_TRACES_HEADERS", warnings),
  }
  // Resource attributes: file < env (same convention)
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
