/**
 * @fileoverview Secret redaction: every log sink (file, stderr) goes through this function; callers
 * cannot bypass it. Shape-based rules, not an adversarial guarantee — the goal is to
 * keep tokens from leaking via previews/error messages.
 * Adapted from oh-my-opencode-slim src/utils/redact.ts.
 */

function maskToken(token: string): string {
  if (token.length <= 8) return "…"
  return `${token.slice(0, 4)}…${token.slice(-2)}`
}

interface Rule {
  readonly pattern: RegExp
  readonly replace: (match: string, ...groups: string[]) => string
}

const RULES: Rule[] = [
  // OpenAI-style API key
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replace: (m) => maskToken(m) },
  // GitHub token (pat / oauth / user / server / refresh)
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{8,}\b/g, replace: (m) => maskToken(m) },
  // GitLab PAT
  { pattern: /\bglpat-[A-Za-z0-9_-]{8,}\b/g, replace: (m) => maskToken(m) },
  // AWS access key id / STS
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b/g, replace: (m) => maskToken(m) },
  // Authorization scheme: keep the scheme word, mask the credential
  {
    pattern: /\b(?:Bearer|Basic|token|Token)\s+[A-Za-z0-9._+/=-]{8,}/g,
    replace: (m) => {
      const split = m.match(/^(\S+)(\s+)([\s\S]+)$/)
      if (!split) return maskToken(m)
      return `${split[1]}${split[2]}${maskToken(split[3])}`
    },
  },
  // Credentials embedded in a URL (scheme://user:password@): mask only the password
  {
    pattern: /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@/]+:([^@\s]+)@/g,
    replace: (m, ...groups) => {
      const password = groups[0]
      if (!password || password.length === 0) return maskToken(m)
      return `${m.slice(0, m.length - password.length - 1)}${maskToken(password)}@`
    },
  },
  // Generic long opaque strings (32+ chars, no spaces/colons/quotes) — false positives
  // on UUIDs/hashes/long paths are an accepted tradeoff
  { pattern: /\b[A-Za-z0-9_\-/.+=]{32,}\b/g, replace: (m) => maskToken(m) },
]

export function redactSecrets(input: string): string {
  let output = input
  for (const rule of RULES) {
    output = output.replace(rule.pattern, (match, ...args) => rule.replace(match, ...(args as string[])))
  }
  return output
}
