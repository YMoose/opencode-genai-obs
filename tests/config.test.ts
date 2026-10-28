/**
 * config.ts tests:
 * - Defaults / JSONC parsing / endpoint normalization
 * - Bug 7: type-mismatched fields warn and fall back to defaults (no more silent JS truthiness)
 * - Unknown-key warnings across the root and wire/tracing/contentGates nesting levels
 * - OTEL env override precedence
 */
import test from "node:test"
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadConfig, type ConfigWarning } from "../src/config.js"
import { snapshotEnv, restoreEnv, tempDir } from "./helpers.js"

interface LoadResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any
  warnings: ConfigWarning[]
}

/** Write config content to a temp file and load it via OCG_OBS_CONFIG (env restored automatically) */
function loadFrom(content: string | null, env: Record<string, string> = {}): LoadResult {
  const snapshot = snapshotEnv()
  try {
    const dir = tempDir("ocg-cfg-")
    const path = join(dir, "ocg-obs.json")
    if (content !== null) writeFileSync(path, content, "utf-8")
    process.env.OCG_OBS_CONFIG = path
    for (const [key, value] of Object.entries(env)) process.env[key] = value
    const { config, warnings } = loadConfig(() => {})
    return { config, warnings }
  } finally {
    restoreEnv(snapshot)
  }
}

const kinds = (warnings: ConfigWarning[]) => warnings.map((warning) => warning.kind)

test("无配置文件：全默认且无告警", () => {
  const { config, warnings } = loadFrom(null)
  assert.strictEqual(config.enabled, true)
  assert.strictEqual(config.wire.enabled, false)
  assert.strictEqual(config.tracing.enabled, true)
  assert.strictEqual(config.tracing.endpoint, "http://localhost:4318", "默认走 OTLP 标准端口")
  assert.strictEqual(config.tracing.contentMaxLength, 61440, "默认 60 KB（对齐 CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH，低于后端 64 KB 单 attr 上限）")
  assert.strictEqual(config.tracing.annotations.enabled, true, "annotations 默认开（兼容既有部署）")
  assert.deepStrictEqual(warnings, [])
})

test("JSONC：注释/尾逗号合法，endpoint 剥 /v1/traces 尾路径与尾斜杠", () => {
  const { config, warnings } = loadFrom(`{
    // phoenix backend
    "tracing": {
      "endpoint": "http://ph:6006/v1/traces/", /** normalized */
      "contentGates": { "userPrompts": false, },
    },
  }`)
  assert.strictEqual(config.tracing.endpoint, "http://ph:6006")
  assert.strictEqual(config.tracing.contentGates.userPrompts, false)
  assert.deepStrictEqual(warnings, [])
})

test("Bug 7：类型不匹配告警并回落默认", () => {
  const { config, warnings } = loadFrom(`{
    "enabled": "false",
    "wire": { "enabled": 1, "directory": 42 },
    "tracing": {
      "contentMaxLength": "500",
      "headers": { "ok": "v", "bad": 7 }
    }
  }`)
  assert.strictEqual(config.enabled, true, "字符串 'false' 不得生效为关闭")
  assert.strictEqual(config.wire.enabled, false, "数字 1 不得生效为开启")
  assert.strictEqual(config.tracing.contentMaxLength, 61440, "字符串长度不得混入")
  assert.deepStrictEqual(config.tracing.headers, { ok: "v" }, "非字符串 header 值跳过")
  const badTypes = warnings.filter((warning) => warning.kind === "bad-type")
  assert.ok(badTypes.length >= 5, `每个类型错误都应告警（实际 ${badTypes.length} 条）`)
})

test("未知 key：根级与 wire/tracing/contentGates 嵌套层都告警", () => {
  const { warnings } = loadFrom(`{
    "bogus": 1,
    "wire": { "dir": "/x" },
    "tracing": { "endpointt": "http://y", "contentGates": { "userprompt": true } }
  }`)
  const unknown = warnings.filter((warning) => warning.kind === "unknown-key").map((warning) => warning.message)
  assert.ok(unknown.some((message) => message.includes('"bogus"')), "根级未知 key")
  assert.ok(unknown.some((message) => message.includes('"wire.dir"')), "wire 层未知 key")
  assert.ok(unknown.some((message) => message.includes('"tracing.endpointt"')), "tracing 层未知 key（拼写错误）")
  assert.ok(unknown.some((message) => message.includes('"tracing.contentGates.userprompt"')), "contentGates 层未知 key")
})

test("content=false：toolDetails/toolContent 默认关，可单独拉回", () => {
  const { config } = loadFrom(`{
    "tracing": { "content": false, "contentGates": { "toolContent": true } }
  }`)
  assert.strictEqual(config.tracing.contentGates.userPrompts, true)
  assert.strictEqual(config.tracing.contentGates.toolDetails, false)
  assert.strictEqual(config.tracing.contentGates.toolContent, true)
})

test("annotations 开关：默认开、可关、坏类型回落并告警", () => {
  const off = loadFrom(`{ "tracing": { "annotations": { "enabled": false } } }`)
  assert.strictEqual(off.config.tracing.annotations.enabled, false, "非 Phoenix 后端可显式关闭")

  const badType = loadFrom(`{ "tracing": { "annotations": { "enabled": "false" } } }`)
  assert.strictEqual(badType.config.tracing.annotations.enabled, true, "字符串 'false' 不得生效")
  assert.ok(badType.warnings.some((warning) => warning.kind === "bad-type" && warning.message.includes("tracing.annotations.enabled")))

  const unknown = loadFrom(`{ "tracing": { "annotations": { "auto": true } } }`)
  assert.ok(unknown.warnings.some((warning) => warning.kind === "unknown-key" && warning.message.includes("tracing.annotations.auto")))
})

test("OTEL env 覆盖文件层：endpoint 归一化、headers 合并、坏对告警", () => {
  const { config, warnings } = loadFrom(
    `{ "tracing": { "endpoint": "http://file:6006", "headers": { "file-key": "fv" } } }`,
    {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://env:9/v1/traces",
      OTEL_EXPORTER_OTLP_HEADERS: "env-key=ev",
      OTEL_RESOURCE_ATTRIBUTES: "env-attr=eav",
    },
  )
  assert.strictEqual(config.tracing.endpoint, "http://env:9", "专用 env endpoint 应覆盖文件")
  assert.deepStrictEqual(config.tracing.headers, { "file-key": "fv", "env-key": "ev" })
  assert.deepStrictEqual(config.tracing.resourceAttributes, { "env-attr": "eav" })

  const bad = loadFrom(`{}`, { OTEL_EXPORTER_OTLP_HEADERS: "a=1,badpair" })
  assert.ok(bad.warnings.some((warning) => warning.kind === "bad-env"))
  assert.deepStrictEqual(bad.config.tracing.headers, { a: "1" })
})

test("Bug 9（opencode #55002 同款）：OTEL env 值按 W3C Baggage percent-decode，坏序列原样保留", () => {
  const { config } = loadFrom(`{}`, {
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20test-token,x-api-key=abc%zz",
    OTEL_RESOURCE_ATTRIBUTES: "team=platform%20team,rate=100%",
  })
  assert.strictEqual(
    config.tracing.headers.Authorization,
    "Bearer test-token",
    "percent-encoded 空格必须解码，否则 collector 收到 Bearer%20test-token 会直接拒收",
  )
  assert.strictEqual(config.tracing.headers["x-api-key"], "abc%zz", "非法 escape 序列不得抛异常，原样保留")
  assert.strictEqual(config.tracing.resourceAttributes.team, "platform team", "resource attributes 同格式同样解码")
  assert.strictEqual(config.tracing.resourceAttributes.rate, "100%", "裸 % 不解码也不得抛")
})

test("wire.maxFrameBytes：默认 -1，三态语义与坏值回落", () => {
  const def = loadFrom(null)
  assert.strictEqual(def.config.wire.maxFrameBytes, -1, "默认全量不截断")

  const bad = loadFrom(`{ "wire": { "maxFrameBytes": "4096" } }`)
  assert.strictEqual(bad.config.wire.maxFrameBytes, -1, "字符串不得生效")
  assert.ok(bad.warnings.some((warning) => warning.kind === "bad-type" && warning.message.includes("wire.maxFrameBytes")))

  const tooLow = loadFrom(`{ "wire": { "maxFrameBytes": -2 } }`)
  assert.strictEqual(tooLow.config.wire.maxFrameBytes, -1, "小于 -1 告警回落")
  assert.ok(tooLow.warnings.some((warning) => warning.kind === "bad-type" && warning.message.includes("wire.maxFrameBytes")))

  const meta = loadFrom(`{ "wire": { "maxFrameBytes": 0 } }`)
  assert.strictEqual(meta.config.wire.maxFrameBytes, 0, "0 = 只记元数据")
  const capped = loadFrom(`{ "wire": { "maxFrameBytes": 65536 } }`)
  assert.strictEqual(capped.config.wire.maxFrameBytes, 65536, "N = 前 N 字节")
})

test("tracing.contentMaxLength：默认 61440，与 wire.maxFrameBytes 三态语义一致", () => {
  const def = loadFrom(null)
  assert.strictEqual(def.config.tracing.contentMaxLength, 61440, "默认 60 KB（对齐 Claude）")

  const bad = loadFrom(`{ "tracing": { "contentMaxLength": "1000" } }`)
  assert.strictEqual(bad.config.tracing.contentMaxLength, 61440, "字符串不得生效")
  assert.ok(bad.warnings.some((warning) => warning.kind === "bad-type" && warning.message.includes("tracing.contentMaxLength")))

  const tooLow = loadFrom(`{ "tracing": { "contentMaxLength": -2 } }`)
  assert.strictEqual(tooLow.config.tracing.contentMaxLength, 61440, "小于 -1 告警回落")
  assert.ok(tooLow.warnings.some((warning) => warning.kind === "bad-type" && warning.message.includes("tracing.contentMaxLength")))

  const unlimited = loadFrom(`{ "tracing": { "contentMaxLength": -1 } }`)
  assert.strictEqual(unlimited.config.tracing.contentMaxLength, -1, "-1 = 不截断")
  const zero = loadFrom(`{ "tracing": { "contentMaxLength": 0 } }`)
  assert.strictEqual(zero.config.tracing.contentMaxLength, 0, "0 = 不保留 attr 值，仅记 *_original_length")
  const capped = loadFrom(`{ "tracing": { "contentMaxLength": 1000 } }`)
  assert.strictEqual(capped.config.tracing.contentMaxLength, 1000, "N = 截到 N 字符")
})
