/**
 * @fileoverview One-shot startup liveness probe for the configured OTLP endpoints.
 *
 * Idea adapted from DEVtheOPS/opencode-plugin-otel probe.ts (MPL-2.0) — a TCP connect
 * with a short timeout at boot tells the user immediately whether the backend is
 * reachable, instead of discovering it through the first span's retry/backoff cycle.
 * Re-derived for our context: OTLP/HTTP-only (no gRPC default-port guessing), pure
 * diagnostics (log-only — the sender's retry/backoff owns the behavioral response, and
 * a backend that comes up later is none of the probe's business), and never called in
 * wire-only mode (the zero-network-egress promise holds).
 */
import { connect } from "node:net"
import { performance } from "node:perf_hooks"

export interface ProbeOutcome {
  readonly ok: boolean
  readonly ms: number
  readonly error?: string
}

/** host/port for a TCP connect; null for anything we can't or shouldn't probe (HTTP-only) */
export function parseEndpoint(endpoint: string): { host: string; port: number } | null {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return null
  }
  if (!url.hostname) return null
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  return { host: url.hostname, port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80 }
}

/** Single TCP connect against the endpoint's host:port. Never rejects. */
export async function probeEndpoint(endpoint: string, timeoutMs = 5_000): Promise<ProbeOutcome> {
  const target = parseEndpoint(endpoint)
  if (!target) return { ok: false, ms: 0, error: `invalid endpoint URL: ${endpoint}` }
  const started = performance.now()
  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome: ProbeOutcome) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(outcome)
    }
    const socket = connect({ host: target.host, port: target.port }, () => {
      finish({ ok: true, ms: Math.round(performance.now() - started) })
    })
    socket.setTimeout(timeoutMs, () => {
      finish({ ok: false, ms: Math.round(performance.now() - started), error: `TCP connect timed out after ${timeoutMs}ms` })
    })
    socket.on("error", (error: Error) => {
      finish({ ok: false, ms: Math.round(performance.now() - started), error: error.message })
    })
  })
}

export interface ProbeTarget {
  /** Signal label(s) sharing this endpoint, e.g. "traces" or "traces+metrics" */
  readonly label: string
  readonly endpoint: string
}

/** Dedup signals that resolve to the same endpoint — one connect per distinct URL */
export function collectProbeTargets(signals: ReadonlyArray<{ label: string; endpoint: string }>): ProbeTarget[] {
  const byEndpoint = new Map<string, string[]>()
  for (const { label, endpoint } of signals) {
    const labels = byEndpoint.get(endpoint) ?? []
    labels.push(label)
    byEndpoint.set(endpoint, labels)
  }
  return [...byEndpoint].map(([endpoint, labels]) => ({ label: labels.join("+"), endpoint }))
}
