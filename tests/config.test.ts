/**
 * config.ts 测试：
 * - 默认值 / JSONC 解析 / endpoint 归一化
 * - Bug 7：类型不匹配的字段告警并回落默认（不再按 JS 真值性静默生效）
 * - 未知 key 告警覆盖根级与 wire/tracing/contentGates 嵌套层
 * - OTEL env 覆盖优先级
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

/** 把配置内容写入临时文件并以 OCG_OBS_CONFIG 加载（自动还原 env） */
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
  assert.strictEqual(config.tracing.endpoint, "http://localhost:6006")
  assert.strictEqual(config.tracing.contentMaxLength, 0)
  assert.deepStrictEqual(warnings, [])
})

test("JSONC：注释/尾逗号合法，endpoint 剥 /v1/traces 尾路径与尾斜杠", () => {
  const { config, warnings } = loadFrom(`{
    // phoenix
    "tracing": {
      "endpoint": "http://ph:6006/v1/traces/", /** 归一化 */
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
  assert.strictEqual(config.tracing.contentMaxLength, 0, "字符串长度不得混入")
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
