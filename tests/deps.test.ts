/**
 * Dependency-contract tests — pattern adapted from oh-my-opencode-slim src/dependency-contract.test.ts.
 * A core selling point of this project is the hand-rolled OTLP protobuf encoding with
 * zero heavyweight SDK dependencies; these tests lock that down: runtime dependencies
 * are jsonc-parser only, and the src/ import graph stays within bounds (node:* builtins,
 * relative paths, declared dependencies, and peer dependencies only).
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

test("minimal runtime dependency closure: dependencies are jsonc-parser only", () => {
  assert.deepStrictEqual(
    Object.keys(manifest.dependencies).sort(),
    ["jsonc-parser"],
    "a new runtime dependency needs a README rationale and an update to this contract",
  )
})

test("the OpenCode plugin API is declared only as a peerDependency (host-provided, not bundled)", () => {
  assert.ok(manifest.peerDependencies["@opencode/plugin"], "@opencode/plugin must be a peer dependency")
  assert.ok(!manifest.dependencies["@opencode/plugin"], "@opencode/plugin must not enter dependencies")
})

test("the src/ import graph stays within bounds", () => {
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
  assert.deepStrictEqual(offenders, [], "src/ has an import of an undeclared dependency")
})
