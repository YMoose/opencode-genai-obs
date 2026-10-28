/**
 * @fileoverview Shared UTF-8 byte-aware cutting primitive.
 *
 * Content caps are expressed in bytes (backend attribute limits — e.g. Phoenix/Jaeger/
 * ClickHouse 64 KB per attribute — are byte budgets), but a naive byte cut can split a
 * multi-byte character. Cuts back up to a UTF-8 character boundary so no U+FFFD
 * replacement character is ever produced.
 */

/** Return the value unchanged when it fits; otherwise cut at the first byteLimit UTF-8 bytes (character-boundary safe). */
export function cutUtf8Bytes(value: string, byteLimit: number): string {
  if (byteLimit < 0 || Buffer.byteLength(value, "utf-8") <= byteLimit) return value
  const buf = Buffer.from(value, "utf-8")
  let end = byteLimit
  // Back up over UTF-8 continuation bytes so the cut lands on a character boundary
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1
  return buf.subarray(0, end).toString("utf-8")
}
