/**
 * 敏感信息脱敏：所有日志出口（文件、stderr）都过这个函数，调用方无法绕过。
 * shape-based 规则，不是对抗性保证 —— 防的是"预览/错误信息里意外带出 token"。
 * 参考 oh-my-opencode-slim src/utils/redact.ts。
 */

/** 掩码：保留前 4 + 后 2 字符，中间用省略号 */
function maskToken(token: string): string {
  if (token.length <= 8) return "…"
  return `${token.slice(0, 4)}…${token.slice(-2)}`
}

interface Rule {
  readonly pattern: RegExp
  readonly replace: (match: string, ...groups: string[]) => string
}

const RULES: Rule[] = [
  // OpenAI 风格 API key
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replace: (m) => maskToken(m) },
  // GitHub token (pat / oauth / user / server / refresh)
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{8,}\b/g, replace: (m) => maskToken(m) },
  // GitLab PAT
  { pattern: /\bglpat-[A-Za-z0-9_-]{8,}\b/g, replace: (m) => maskToken(m) },
  // AWS access key id / STS
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b/g, replace: (m) => maskToken(m) },
  // Authorization scheme：保留 scheme 词，掩码凭证
  {
    pattern: /\b(?:Bearer|Basic|token|Token)\s+[A-Za-z0-9._+/=-]{8,}/g,
    replace: (m) => {
      const split = m.match(/^(\S+)(\s+)([\s\S]+)$/)
      if (!split) return maskToken(m)
      return `${split[1]}${split[2]}${maskToken(split[3])}`
    },
  },
  // URL 内嵌凭证 scheme://user:password@ —— 只掩码密码
  {
    pattern: /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@/]+:([^@\s]+)@/g,
    replace: (m, ...groups) => {
      const password = groups[0]
      if (!password || password.length === 0) return maskToken(m)
      return `${m.slice(0, m.length - password.length - 1)}${maskToken(password)}@`
    },
  },
  // 通用长不透明串（32+ 字符，无空格/冒号/引号）—— UUID/hash/长路径会误伤，接受
  { pattern: /\b[A-Za-z0-9_\-/.+=]{32,}\b/g, replace: (m) => maskToken(m) },
]

export function redactSecrets(input: string): string {
  let output = input
  for (const rule of RULES) {
    output = output.replace(rule.pattern, (match, ...args) => rule.replace(match, ...(args as string[])))
  }
  return output
}
