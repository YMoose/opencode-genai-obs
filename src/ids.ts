/**
 * @fileoverview The deterministic-id contract — FROZEN.
 *
 * Every trace/span id is a pure hash of stable inputs (no random ids, no UUIDs), so that:
 * - multiple plugin realms emitting the same event produce identical ids → backends with
 *   idempotent upserts (Phoenix-style DO_NOTHING) dedupe them for free
 * - the offline replay lane (obsystem/otel-span-exportor/adapter.py) computes byte-identical
 *   ids from stored data → crash repair / historical backfill never creates duplicates
 *
 * CONTRACT: these formulas are mirrored in Python and must stay byte-stable once published.
 * Changing a prefix, an input order, or a byte length silently breaks offline-replay dedup.
 * tests/ids.test.ts pins the exact outputs — if it goes red, you are changing the contract,
 * not fixing a bug.
 */
import { createHash } from "node:crypto"

function hash(input: string, bytes: number): string {
  return createHash("sha256").update(input).digest("hex").slice(0, bytes * 2)
}

/** Trace of one conversation turn */
export const turnTraceId = (sid: string, userMessageID: string): string =>
  hash(`opencode-turn:${sid}:${userMessageID}`, 16)

/** Root span of one conversation turn */
export const turnSpanId = (sid: string, userMessageID: string): string =>
  hash(`opencode-turn-span:${sid}:${userMessageID}`, 8)

/** Chat span (one model step) */
export const chatSpanId = (assistantMessageID: string): string => hash(`opencode-chat:${assistantMessageID}`, 8)

/** Tool span (one tool call inside a step) */
export const toolSpanId = (assistantMessageID: string, toolCallID: string): string =>
  hash(`opencode-tool:${assistantMessageID}:${toolCallID}`, 8)

/** Sub-agent container span */
export const sessionSpanId = (childSessionID: string): string => hash(`opencode-session:${childSessionID}`, 8)

/** Standalone trace of a sub-agent whose parent turn already closed (abnormal ordering) */
export const orphanTraceId = (sid: string): string => hash(`opencode-turn:${sid}:orphan`, 16)

/** Trace of one compaction run */
export const compactionTraceId = (sid: string, startedMs: string): string =>
  hash(`opencode-compaction:${sid}:${startedMs}`, 16)

/** Root span of one compaction run */
export const compactionSpanId = (sid: string, startedMs: string): string =>
  hash(`opencode-compaction-span:${sid}:${startedMs}`, 8)
