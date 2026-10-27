/**
 * redact.ts 测试 —— 模式移植自 oh-my-opencode-slim src/utils/redact.test.ts。
 * 规则集以本项目 redact.ts 为准（无 Slack xox 规则；有 32+ 通用长串规则）。
 * token fixture 用数组 join 构造，避免 secret 扫描 / GitHub push protection
 * 把测试仓库误报为携带真凭证。AKIAIOSFODNN7EXAMPLE 是 AWS 文档官方示例 key，
 * 按惯例保留明文。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { redactSecrets } from "../src/redact.js"

const SK_TOKEN = ["sk-", "proj-", "abcdef1234567890", "abcdef"].join("")
const GH_TOKEN = (kind: "ghp" | "gho" | "ghu" | "ghs" | "ghr") =>
  [kind, "_", "ABCDEFGHIJKLMNOP", "QRSTUVWXYZ1234"].join("")
const BEARER_TOKEN = ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", ".payload.sig"].join("")

test("掩码 OpenAI 风格 sk- token（保留前 4 后 2，中间消失）", () => {
  const out = redactSecrets(`call failed with ${SK_TOKEN} in env`)
  assert.ok(out.includes("sk-p"), "应保留前缀")
  assert.ok(out.includes("…"), "中间应被省略号替换")
  assert.ok(!out.includes(SK_TOKEN), "完整 token 不得残留")
})

test("掩码 GitHub token（ghp_/gho_/ghu_/ghs_/ghr_）", () => {
  for (const kind of ["ghp", "gho", "ghu", "ghs", "ghr"] as const) {
    const token = GH_TOKEN(kind)
    const out = redactSecrets(`auth: ${token}`)
    assert.ok(out.startsWith("auth: gh"), `${kind} 前缀保留`)
    assert.ok(!out.includes(token), `${kind} 完整 token 不得残留`)
  }
})

test("掩码 GitLab PAT（glpat-…）", () => {
  const token = ["glpat-", "Abcdef1234567890", "123"].join("")
  const out = redactSecrets(`gitlab ${token}`)
  assert.ok(!out.includes(token))
  assert.ok(out.includes("glpa…23"))
})

test("掩码 AWS access key id / STS 临时 key（AKIA/ASIA…）", () => {
  // AWS 文档官方示例 key id —— 按惯例明文
  for (const token of ["AKIAIOSFODNN7EXAMPLE", "ASIAIOSFODNN7EXAMPLE"]) {
    const out = redactSecrets(`key=${token}`)
    assert.ok(out.includes(token.slice(0, 4)), "保留 AKIA/ASIA 前缀")
    assert.ok(!out.includes(token), "完整 key 不得残留")
  }
})

test("掩码 Bearer/Basic/token 凭证（scheme 词保留）", () => {
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

test("URL 内嵌凭证只掩密码，用户名/主机保留", () => {
  const password = ["S3cr3tPass", "_w0rd"].join("")
  const dsn = `postgres://deploy:${password}@db.internal.io:5432/app`
  const out = redactSecrets(`dsn: ${dsn}`)
  assert.ok(out.includes("postgres://deploy:"), "scheme+用户名保留")
  assert.ok(out.includes("@db.internal.io:5432/app"), "主机与路径保留")
  assert.ok(!out.includes(password), "密码不得残留")

  const plain = "postgres://deploy@db.internal.io:5432/app"
  // 无密码 URL 不被 URL 规则改写（32+ 通用规则不触：总长不足 32 且含 : / 之外…host 段为 16 字符）
  assert.equal(redactSecrets(`dsn: ${plain}`), `dsn: ${plain}`)
})

test("掩码 32+ 字符通用长不透明串", () => {
  const token = "Z9xQ1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7"
  const out = redactSecrets(`api returned ${token} please check`)
  assert.ok(!out.includes(token))
})

test("每个出现都被掩码，不只是第一处", () => {
  const a = ["sk-", "aaaaaaaaaaaaaaaa", "aaaaaa"].join("")
  const b = GH_TOKEN("ghp")
  const out = redactSecrets(`${a} and ${b}`)
  assert.ok(!out.includes(a))
  assert.ok(!out.includes(b))
})

test("普通短文本原样通过", () => {
  const text = ["task_id: ses_8db21a44fe0a97cf", "state: running", "Background task started."].join("\n")
  assert.equal(redactSecrets(text), text)
})
