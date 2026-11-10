/**
 * @fileoverview Persistent set of sessions that have exported ≥1 span (Bug 39).
 *
 * Why: Phoenix creates a ProjectSession row lazily on the first ingested span, so a
 * session that never exported a span (e.g. probe-only sub-agent sessions) has no row
 * and its annotation POST 404s forever. The startup annotation backfill consults this
 * set and annotates only known-exported sessions (user decision A+B, 2026-11-10).
 * Live event-driven annotation does NOT consult the set — its 404 race self-heals by
 * retry, and live sessions must be annotated regardless.
 *
 * State file: $OCG_OBS_EXPORTED_SESSIONS (test/isolation override) or
 * ~/.local/share/opencode/ocg-obs-exported-sessions.json — the same data dir that
 * holds raw-requests/ and log/. Best-effort: every read/write failure logs and never
 * throws; a corrupt or missing file starts empty.
 *
 * Bootstrap caveat: on first run after the upgrade the file does not exist, so the
 * first backfill annotates ~nothing — acceptable, because Phoenix rows created before
 * the upgrade already carry their old labels, and every session that runs a round
 * after the upgrade is marked by its first span.
 *
 * FIFO cap (8192 ids, ~0.5 MB): the set is a lossy cache of "has a Phoenix row", not
 * a ledger — sessions older than the newest 8192 are forgotten and the next backfill
 * skips them. Boundary/blast radius: one missing label refresh for a >8192-session
 * backlog between backfills; the offline sync.py backstop fills it. Writes are
 * atomic (tmp+rename), so a crash never leaves a torn file.
 *
 * Multi-process: opencode runs several module realms; concurrent marks do
 * read-merge-write, so the atomic rename can still lose another process's mark in
 * the same instant (last writer wins). Blast radius: one session skipped by one
 * backfill run; it is re-marked on its next span.
 */
import * as fs from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/** Newest ids kept when the FIFO cap is hit (see fileoverview for the blast radius) */
const DEFAULT_CAPACITY = 8_192

interface StoredState {
  exported: string[]
}

function defaultPath(): string {
  return process.env.OCG_OBS_EXPORTED_SESSIONS ?? join(homedir(), ".local", "share", "opencode", "ocg-obs-exported-sessions.json")
}

export interface ExportedSessionsStore {
  /** All known exported session ids (persisted file ∪ in-memory marks of this process) */
  readonly load: () => Set<string>
  /** Record a session as span-exported; persists on the first sighting in this process only */
  readonly mark: (sessionID: string) => void
}

export function createExportedSessionsStore(
  log: (msg: string, data?: unknown) => void,
  options?: { readonly path?: string; readonly capacity?: number },
): ExportedSessionsStore {
  const filePath = options?.path ?? defaultPath()
  const capacity = options?.capacity ?? DEFAULT_CAPACITY
  const known = new Set<string>()

  const readIds = (): string[] => {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as StoredState
      if (parsed && Array.isArray(parsed.exported)) {
        return parsed.exported.filter((id): id is string => typeof id === "string")
      }
    } catch {
      // Missing or corrupt ⇒ empty (documented bootstrap; never a pipeline failure)
    }
    return []
  }

  const writeIds = (ids: string[]): void => {
    try {
      const tmp = `${filePath}.tmp-${process.pid}`
      fs.mkdirSync(dirname(filePath), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify({ exported: ids } satisfies StoredState))
      fs.renameSync(tmp, filePath)
    } catch (error) {
      log("exported-sessions state write failed", { path: filePath, error: String(error) })
    }
  }

  return {
    load() {
      for (const id of readIds()) known.add(id)
      return new Set(known)
    },
    mark(sessionID) {
      if (known.has(sessionID)) return
      known.add(sessionID) // in-memory even when the write below fails
      // Re-read and merge: another process may have appended since our last write
      const ids = readIds()
      if (ids.includes(sessionID)) return
      ids.push(sessionID)
      writeIds(ids.length > capacity ? ids.slice(ids.length - capacity) : ids)
    },
  }
}
