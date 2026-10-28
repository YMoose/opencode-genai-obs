/**
 * redact.ts tests — pattern ported from oh-my-opencode-slim src/utils/redact.test.ts.
 * The rule set follows this project's redact.ts (no Slack xox rule; a generic 32+
 * long-string rule). Token fixtures are built via array joins so secret scanners /
 * GitHub push protection don't flag the test repo as carrying real credentials.
 * AKIAIOSFODNN7EXAMPLE is the official AWS doc example key, kept in plaintext by
 * convention.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { redactSecrets } from "../src/redact.js"

const SK_TOKEN = ["sk-", "proj-", "abcdef1234567890", "abcdef"].join("")
const GH_TOKEN = (kind: "ghp" | "gho" | "ghu" | "ghs" | "ghr") =>
  [kind, "_", "ABCDEFGHIJKLMNOP", "QRSTUVWXYZ1234"].join("")
const BEARER_TOKEN = ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", ".payload.sig"].join("")

test("masks OpenAI-style sk- tokens (keeps the first 4 and last 2, middle elided)", () => {
  const out = redactSecrets(`call failed with ${SK_TOKEN} in env`)
  assert.ok(out.includes("sk-p"), "prefix must be preserved")
  assert.ok(out.includes("…"), "middle must be replaced by an ellipsis")
  assert.ok(!out.includes(SK_TOKEN), "the full token must not remain")
})

test("masks GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_)", () => {
  for (const kind of ["ghp", "gho", "ghu", "ghs", "ghr"] as const) {
    const token = GH_TOKEN(kind)
    const out = redactSecrets(`auth: ${token}`)
    assert.ok(out.startsWith("auth: gh"), `${kind} prefix preserved`)
    assert.ok(!out.includes(token), `${kind} full token must not remain`)
  }
})

test("masks GitLab PATs (glpat-…)", () => {
  const token = ["glpat-", "Abcdef1234567890", "123"].join("")
  const out = redactSecrets(`gitlab ${token}`)
  assert.ok(!out.includes(token))
  assert.ok(out.includes("glpa…23"))
})

test("masks AWS access key ids / STS temporary keys (AKIA/ASIA…)", () => {
  // official AWS doc example key id — plaintext by convention
  for (const token of ["AKIAIOSFODNN7EXAMPLE", "ASIAIOSFODNN7EXAMPLE"]) {
    const out = redactSecrets(`key=${token}`)
    assert.ok(out.includes(token.slice(0, 4)), "AKIA/ASIA prefix preserved")
    assert.ok(!out.includes(token), "the full key must not remain")
  }
})

test("masks Bearer/Basic/token credentials (scheme word preserved)", () => {
  const bearer = redactSecrets(`Authorization: Bearer ${BEARER_TOKEN}`)
  assert.ok(bearer.includes("Bearer"))
  assert.ok(!bearer.includes(BEARER_TOKEN))

  const basic = ["dXNl", "cjpwYXNzd29yZA", "=="].join("")
  const out = redactSecrets(`Authorization: Basic ${basic}`)
  assert.ok(out.includes("Basic"))
  assert.ok(!out.includes(basic))

  const scheme = ["sup3r-s3cret", "-session-token_value"].join("")
  const out2 = redactSecrets(`token ${scheme}`)
  assert.ok(out2.includes("token"))
  assert.ok(!out2.includes(scheme))
})

test("URL credentials: only the password is masked; username/host preserved", () => {
  const password = ["S3cr3tPass", "_w0rd"].join("")
  const dsn = `postgres://deploy:${password}@db.internal.io:5432/app`
  const out = redactSecrets(`dsn: ${dsn}`)
  assert.ok(out.includes("postgres://deploy:"), "scheme+username preserved")
  assert.ok(out.includes("@db.internal.io:5432/app"), "host and path preserved")
  assert.ok(!out.includes(password), "password must not remain")

  const plain = "postgres://deploy@db.internal.io:5432/app"
  // a password-less URL is not rewritten by the URL rule (the 32+ generic rule does not fire either: total length under 32, host segment is 16 chars)
  assert.equal(redactSecrets(`dsn: ${plain}`), `dsn: ${plain}`)
})

test("masks generic 32+ char long opaque strings", () => {
  const token = "Z9xQ1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7"
  const out = redactSecrets(`api returned ${token} please check`)
  assert.ok(!out.includes(token))
})

test("every occurrence is masked, not just the first", () => {
  const a = ["sk-", "aaaaaaaaaaaaaaaa", "aaaaaa"].join("")
  const b = GH_TOKEN("ghp")
  const out = redactSecrets(`${a} and ${b}`)
  assert.ok(!out.includes(a))
  assert.ok(!out.includes(b))
})

test("ordinary short text passes through unchanged", () => {
  const text = ["task_id: ses_8db21a44fe0a97cf", "state: running", "Background task started."].join("\n")
  assert.equal(redactSecrets(text), text)
})
