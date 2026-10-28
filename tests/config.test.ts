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

test("no config file: all defaults, no warnings", () => {
  const { config, warnings } = loadFrom(null)
  assert.strictEqual(config.enabled, true)
  assert.strictEqual(config.wire.enabled, false)
  assert.strictEqual(config.tracing.enabled, true)
  assert.strictEqual(config.tracing.endpoint, "http://localhost:4318", "default must be the OTLP standard port")
  assert.strictEqual(config.tracing.contentMaxLength, 61440, "default 60 KB (matches CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH, under the backend 64 KB per-attr limit)")
  assert.strictEqual(config.tracing.annotations.enabled, true, "annotations default to on (compatible with existing deployments)")
  assert.deepStrictEqual(warnings, [])
})

test("JSONC: comments/trailing commas are valid; endpoint strips the /v1/traces path and trailing slash", () => {
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

test("Bug 7: type mismatches warn and fall back to defaults", () => {
  const { config, warnings } = loadFrom(`{
    "enabled": "false",
    "wire": { "enabled": 1, "directory": 42 },
    "tracing": {
      "contentMaxLength": "500",
      "headers": { "ok": "v", "bad": 7 }
    }
  }`)
  assert.strictEqual(config.enabled, true, "the string 'false' must not take effect as disabled")
  assert.strictEqual(config.wire.enabled, false, "the number 1 must not take effect as enabled")
  assert.strictEqual(config.tracing.contentMaxLength, 61440, "a string length must not slip in")
  assert.deepStrictEqual(config.tracing.headers, { ok: "v" }, "non-string header values are skipped")
  const badTypes = warnings.filter((warning) => warning.kind === "bad-type")
  assert.ok(badTypes.length >= 5, `every type error must warn (actual: ${badTypes.length})`)
})

test("unknown keys: warn at the root and in the nested wire/tracing/contentGates levels", () => {
  const { warnings } = loadFrom(`{
    "bogus": 1,
    "wire": { "dir": "/x" },
    "tracing": { "endpointt": "http://y", "contentGates": { "userprompt": true } }
  }`)
  const unknown = warnings.filter((warning) => warning.kind === "unknown-key").map((warning) => warning.message)
  assert.ok(unknown.some((message) => message.includes('"bogus"')), "unknown key at the root")
  assert.ok(unknown.some((message) => message.includes('"wire.dir"')), "unknown key in the wire level")
  assert.ok(unknown.some((message) => message.includes('"tracing.endpointt"')), "unknown key in the tracing level (typo)")
  assert.ok(unknown.some((message) => message.includes('"tracing.contentGates.userprompt"')), "unknown key in the contentGates level")
})

test("content=false: toolDetails/toolContent off by default, individually re-enableable", () => {
  const { config } = loadFrom(`{
    "tracing": { "content": false, "contentGates": { "toolContent": true } }
  }`)
  assert.strictEqual(config.tracing.contentGates.userPrompts, true)
  assert.strictEqual(config.tracing.contentGates.toolDetails, false)
  assert.strictEqual(config.tracing.contentGates.toolContent, true)
})

test("annotations toggle: on by default, can be disabled, bad types fall back and warn", () => {
  const off = loadFrom(`{ "tracing": { "annotations": { "enabled": false } } }`)
  assert.strictEqual(off.config.tracing.annotations.enabled, false, "non-Phoenix backends can disable it explicitly")

  const badType = loadFrom(`{ "tracing": { "annotations": { "enabled": "false" } } }`)
  assert.strictEqual(badType.config.tracing.annotations.enabled, true, "the string 'false' must not take effect")
  assert.ok(badType.warnings.some((warning) => warning.kind === "bad-type" && warning.message.includes("tracing.annotations.enabled")))

  const unknown = loadFrom(`{ "tracing": { "annotations": { "auto": true } } }`)
  assert.ok(unknown.warnings.some((warning) => warning.kind === "unknown-key" && warning.message.includes("tracing.annotations.auto")))
})

test("OTEL env overrides the file layer: endpoint normalized, headers merged, bad pairs warn", () => {
  const { config, warnings } = loadFrom(
    `{ "tracing": { "endpoint": "http://file:6006", "headers": { "file-key": "fv" } } }`,
    {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://env:9/v1/traces",
      OTEL_EXPORTER_OTLP_HEADERS: "env-key=ev",
      OTEL_RESOURCE_ATTRIBUTES: "env-attr=eav",
    },
  )
  assert.strictEqual(config.tracing.endpoint, "http://env:9", "the dedicated env endpoint must override the file")
  assert.deepStrictEqual(config.tracing.headers, { "file-key": "fv", "env-key": "ev" })
  assert.deepStrictEqual(config.tracing.resourceAttributes, { "env-attr": "eav" })

  const bad = loadFrom(`{}`, { OTEL_EXPORTER_OTLP_HEADERS: "a=1,badpair" })
  assert.ok(bad.warnings.some((warning) => warning.kind === "bad-env"))
  assert.deepStrictEqual(bad.config.tracing.headers, { a: "1" })
})

test("Bug 9 (same as opencode #55002): OTEL env values percent-decode per W3C Baggage; bad sequences kept verbatim", () => {
  const { config } = loadFrom(`{}`, {
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20test-token,x-api-key=abc%zz",
    OTEL_RESOURCE_ATTRIBUTES: "team=platform%20team,rate=100%",
  })
  assert.strictEqual(
    config.tracing.headers.Authorization,
    "Bearer test-token",
    "percent-encoded spaces must decode, or the collector rejects Bearer%20test-token outright",
  )
  assert.strictEqual(config.tracing.headers["x-api-key"], "abc%zz", "an invalid escape sequence must not throw and is kept verbatim")
  assert.strictEqual(config.tracing.resourceAttributes.team, "platform team", "resource attributes use the same format and decode too")
  assert.strictEqual(config.tracing.resourceAttributes.rate, "100%", "a bare % is left undecoded and must not throw")
})

test("wire.maxFrameBytes: default -1, tri-state semantics and bad-value fallback", () => {
  const def = loadFrom(null)
  assert.strictEqual(def.config.wire.maxFrameBytes, -1, "default keeps the full frame untruncated")

  const bad = loadFrom(`{ "wire": { "maxFrameBytes": "4096" } }`)
  assert.strictEqual(bad.config.wire.maxFrameBytes, -1, "a string must not take effect")
  assert.ok(bad.warnings.some((warning) => warning.kind === "bad-type" && warning.message.includes("wire.maxFrameBytes")))

  const tooLow = loadFrom(`{ "wire": { "maxFrameBytes": -2 } }`)
  assert.strictEqual(tooLow.config.wire.maxFrameBytes, -1, "below -1 warns and falls back")
  assert.ok(tooLow.warnings.some((warning) => warning.kind === "bad-type" && warning.message.includes("wire.maxFrameBytes")))

  const meta = loadFrom(`{ "wire": { "maxFrameBytes": 0 } }`)
  assert.strictEqual(meta.config.wire.maxFrameBytes, 0, "0 = metadata only")
  const capped = loadFrom(`{ "wire": { "maxFrameBytes": 65536 } }`)
  assert.strictEqual(capped.config.wire.maxFrameBytes, 65536, "N = first N bytes")
})

test("tracing.contentMaxLength: default 61440, same tri-state semantics as wire.maxFrameBytes", () => {
  const def = loadFrom(null)
  assert.strictEqual(def.config.tracing.contentMaxLength, 61440, "default 60 KB (aligned with Claude)")

  const bad = loadFrom(`{ "tracing": { "contentMaxLength": "1000" } }`)
  assert.strictEqual(bad.config.tracing.contentMaxLength, 61440, "a string must not take effect")
  assert.ok(bad.warnings.some((warning) => warning.kind === "bad-type" && warning.message.includes("tracing.contentMaxLength")))

  const tooLow = loadFrom(`{ "tracing": { "contentMaxLength": -2 } }`)
  assert.strictEqual(tooLow.config.tracing.contentMaxLength, 61440, "below -1 warns and falls back")
  assert.ok(tooLow.warnings.some((warning) => warning.kind === "bad-type" && warning.message.includes("tracing.contentMaxLength")))

  const unlimited = loadFrom(`{ "tracing": { "contentMaxLength": -1 } }`)
  assert.strictEqual(unlimited.config.tracing.contentMaxLength, -1, "-1 = no truncation")
  const zero = loadFrom(`{ "tracing": { "contentMaxLength": 0 } }`)
  assert.strictEqual(zero.config.tracing.contentMaxLength, 0, "0 = drop attribute values, keep only *_original_length")
  const capped = loadFrom(`{ "tracing": { "contentMaxLength": 1000 } }`)
  assert.strictEqual(capped.config.tracing.contentMaxLength, 1000, "N = truncate to N chars")
})

test("metrics: defaults on with 60s interval; tracing.enabled=false forces metrics off", () => {
  const { config: def } = loadFrom(null)
  assert.strictEqual(def.metrics.enabled, true, "metrics are on by default")
  assert.strictEqual(def.metrics.intervalMs, 60_000)

  const { config: off } = loadFrom(`{ "metrics": { "enabled": false } }`)
  assert.strictEqual(off.metrics.enabled, false)

  // Wire-only mode (tracing.enabled=false) must not leak: metrics are a network signal too
  const { config: wireOnly } = loadFrom(`{ "tracing": { "enabled": false }, "wire": { "enabled": true } }`)
  assert.strictEqual(wireOnly.metrics.enabled, false, "wire-only mode forces metrics off")

  const { config: bad, warnings } = loadFrom(`{ "metrics": { "intervalMs": "fast" } }`)
  assert.strictEqual(bad.metrics.intervalMs, 60_000, "bad type falls back to default")
  assert.ok(warnings.some((w) => w.message.includes("metrics.intervalMs")))
})

test("metrics endpoint: metrics env > generic env > file metrics.endpoint > tracing.endpoint", () => {
  const { config: fromTracing } = loadFrom(`{ "tracing": { "endpoint": "http://traces:4318" } }`)
  assert.strictEqual(fromTracing.metrics.endpoint, "http://traces:4318", "falls back to tracing.endpoint")

  const { config: fromFile } = loadFrom(`{ "metrics": { "endpoint": "http://m:4318/v1/metrics" }, "tracing": { "endpoint": "http://t:4318" } }`)
  assert.strictEqual(fromFile.metrics.endpoint, "http://m:4318", "file metrics.endpoint wins; /v1/metrics suffix stripped")

  const { config: fromEnv } = loadFrom(null, { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://env:4318/" })
  assert.strictEqual(fromEnv.metrics.endpoint, "http://env:4318", "metrics env wins over everything")
})

test("logs: off by default; endpoint resolves logs env > generic env > file > tracing.endpoint", () => {
  const { config: def } = loadFrom(null)
  assert.strictEqual(def.logs.enabled, false, "logs lane is opt-in")
  assert.strictEqual(def.logs.endpoint, "http://localhost:4318", "endpoint still resolves for when it is enabled")

  const { config: on } = loadFrom(`{ "logs": { "enabled": true, "endpoint": "http://l:4318/v1/logs" } }`)
  assert.strictEqual(on.logs.enabled, true)
  assert.strictEqual(on.logs.endpoint, "http://l:4318", "/v1/logs suffix stripped")

  const { config: envWins } = loadFrom(`{ "logs": { "enabled": true } }`, { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://env:4318/" })
  assert.strictEqual(envWins.logs.endpoint, "http://env:4318")

  const { config: wireOnly } = loadFrom(`{ "tracing": { "enabled": false }, "logs": { "enabled": true } }`)
  assert.strictEqual(wireOnly.logs.enabled, false, "wire-only mode forces logs off")
})

test("OTEL_SERVICE_NAME: env sets the resource service.name, beating OTEL_RESOURCE_ATTRIBUTES and file", () => {
  const { config: def } = loadFrom(null)
  assert.strictEqual(def.tracing.resourceAttributes["service.name"], undefined, "no default service.name in config (modules apply the fallback)")

  const { config: fromEnv } = loadFrom(null, { OTEL_SERVICE_NAME: "org-opencode" })
  assert.strictEqual(fromEnv.tracing.resourceAttributes["service.name"], "org-opencode")

  const { config: precedence } = loadFrom(null, {
    OTEL_SERVICE_NAME: "org-opencode",
    OTEL_RESOURCE_ATTRIBUTES: "service.name=ra-name,team.id=core",
  })
  assert.strictEqual(precedence.tracing.resourceAttributes["service.name"], "org-opencode", "OTEL_SERVICE_NAME wins over OTEL_RESOURCE_ATTRIBUTES")
  assert.strictEqual(precedence.tracing.resourceAttributes["team.id"], "core", "other resource attributes still merge")

  const { config: fileBase } = loadFrom(`{ "tracing": { "resourceAttributes": { "service.name": "file-name" } } }`, {
    OTEL_SERVICE_NAME: "org-opencode",
  })
  assert.strictEqual(fileBase.tracing.resourceAttributes["service.name"], "org-opencode", "env wins over file")
})

test("per-signal headers: metrics/logs get file < generic env < signal env; traces headers must not leak across signals", () => {
  const { config } = loadFrom(`{ "tracing": { "headers": { "shared": "file", "fileonly": "f" } } }`, {
    OTEL_EXPORTER_OTLP_HEADERS: "shared=generic,genonly=g",
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: "shared=traces,traceonly=t",
    OTEL_EXPORTER_OTLP_METRICS_HEADERS: "shared=metrics,metonly=m",
    OTEL_EXPORTER_OTLP_LOGS_HEADERS: "shared=logs,logonly=l",
  })
  assert.deepStrictEqual(config.tracing.headers, {
    shared: "traces",
    fileonly: "f",
    genonly: "g",
    traceonly: "t",
  })
  assert.deepStrictEqual(config.metrics.headers, {
    shared: "metrics",
    fileonly: "f",
    genonly: "g",
    metonly: "m",
  }, "metrics headers merge file<generic<metrics-env, no traces leak")
  assert.deepStrictEqual(config.logs.headers, {
    shared: "logs",
    fileonly: "f",
    genonly: "g",
    logonly: "l",
  }, "logs headers merge file<generic<logs-env, no traces leak")
})

test("logs.intervalMs: default 2000, file-configurable, non-numbers warn and fall back", () => {
  const { config: def, warnings: defW } = loadFrom(null)
  assert.strictEqual(def.logs.intervalMs, 2000, "default matches the BatchLogRecordProcessor delay we ship")
  assert.deepStrictEqual(defW, [])

  const { config: custom } = loadFrom(`{ "logs": { "intervalMs": 5000 } }`)
  assert.strictEqual(custom.logs.intervalMs, 5000)

  const { config: bad, warnings } = loadFrom(`{ "logs": { "intervalMs": "fast" } }`)
  assert.strictEqual(bad.logs.intervalMs, 2000)
  assert.ok(warnings.some((w) => w.kind === "bad-type" && w.message.includes("logs.intervalMs")))
})

test("parseKvList edge cases: first '=' splits, empty values kept, malformed pairs skipped", () => {
  const { config } = loadFrom(null, {
    OTEL_EXPORTER_OTLP_HEADERS: "auth=Bearer abc=123,empty=,novalue,=nokey,valid=yes",
  })
  assert.strictEqual(config.tracing.headers["auth"], "Bearer abc=123", "a value may itself contain '=' — split on the first only")
  assert.strictEqual(config.tracing.headers["empty"], "", "empty values are kept")
  assert.strictEqual(config.tracing.headers["valid"], "yes")
  assert.strictEqual(config.tracing.headers["novalue"], undefined, "a pair without '=' is skipped")
  assert.strictEqual(config.tracing.headers[""], undefined, "a pair without a key is skipped")
})
