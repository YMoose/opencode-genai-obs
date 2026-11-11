/**
 * @fileoverview Upstream event-envelope validation (Bug 45). The opencode event stream and
 * the prompt-hook payloads are untyped at our boundary: every field we consume is cast, so a
 * missing or mistyped leaf surfaces as a TypeError deep inside the span state machine — often
 * as an unhandled rejection (the terminal flush is voided) or after a dedup commit, losing the
 * span for good. These readers are the one tolerance point: they never throw, and callers
 * decide whether the degraded value is usable.
 */

/** Token usage as published by step/compaction terminals (all leaves numeric) */
export interface TokenUsage {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}

export interface TokensRead {
  /** undefined = the field itself is absent → no usage attributes at all (unchanged semantics) */
  readonly tokens: TokenUsage | undefined
  /** Leaves that were missing or mistyped and defaulted to 0; empty for a well-formed payload */
  readonly degraded: string[]
}

/** Non-string → "", so a text-consuming code path can never throw on the value */
export const readString = (value: unknown): string => (typeof value === "string" ? value : "")

/** Non-finite/non-number → undefined, so callers must pick an explicit fallback */
export const readNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

/** Epoch ms of the envelope; a non-numeric created cannot be converted to nanos at all */
export const readCreated = (value: unknown): number | undefined => readNumber(value)

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined

/**
 * Normalize a tokens payload. Absent stays absent (that semantic is load-bearing: no usage
 * attributes), while a present-but-partial payload defaults only the leaves the pre-fix code
 * crashed or produced NaN on — never inventing usage for a value we did observe.
 */
export function readTokens(value: unknown): TokensRead {
  if (value === undefined || value === null) return { tokens: undefined, degraded: [] }
  const raw = asRecord(value)
  if (!raw) return { tokens: undefined, degraded: ["tokens"] }
  const degraded: string[] = []
  const leaf = (name: string, leafValue: unknown): number => {
    const parsed = readNumber(leafValue)
    if (parsed === undefined) {
      degraded.push(name)
      return 0
    }
    return parsed
  }
  return {
    tokens: {
      input: leaf("input", raw.input),
      output: leaf("output", raw.output),
      reasoning: leaf("reasoning", raw.reasoning),
      cache: { read: leaf("cache.read", asRecord(raw.cache)?.read), write: leaf("cache.write", asRecord(raw.cache)?.write) },
    },
    degraded,
  }
}
