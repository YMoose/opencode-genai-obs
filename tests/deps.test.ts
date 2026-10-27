/**
 * 依赖契约测试 —— 模式参考 oh-my-opencode-slim src/dependency-contract.test.ts。
 * 本项目的核心卖点之一是 OTLP protobuf 手写编码、零重量级 SDK 依赖，
 * 用测试锁住依赖闭包：运行时 dependencies 仅 jsonc-parser，src/ 的 import
 * 图不得越界（只允许 node:* 内置、相对路径、已声明依赖与 peer 依赖）。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
  dependencies: Record<string, string>
  peerDependencies: Record<string, string>
}

test("运行时依赖闭包最小：dependencies 仅 jsonc-parser", () => {
  assert.deepStrictEqual(
    Object.keys(manifest.dependencies).sort(),
    ["jsonc-parser"],
    "新增运行时依赖必须在 README 说明理由并在此更新契约",
  )
})

test("OpenCode 插件 API 只以 peerDependency 声明（宿主提供，不打进产物）", () => {
  assert.ok(manifest.peerDependencies["@opencode/plugin"], "@opencode/plugin 应为 peer 依赖")
  assert.ok(!manifest.dependencies["@opencode/plugin"], "@opencode/plugin 不得进 dependencies")
})

test("src/ import 图不越界", () => {
  const declared = new Set([...Object.keys(manifest.dependencies), ...Object.keys(manifest.peerDependencies)])
  const allowed = (specifier: string): boolean =>
    specifier.startsWith("node:") || specifier.startsWith("./") || specifier.startsWith("../") || declared.has(specifier)

  const offenders: Array<{ file: string; specifier: string }> = []
  const scan = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) scan(full)
      else if (entry.name.endsWith(".ts")) {
        const source = readFileSync(full, "utf-8")
        for (const match of source.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)) {
          if (!allowed(match[1]!)) offenders.push({ file: full.replace(root + "/", ""), specifier: match[1]! })
        }
      }
    }
  }
  scan(join(root, "src"))
  assert.deepStrictEqual(offenders, [], "src/ 出现未声明依赖的 import")
})
