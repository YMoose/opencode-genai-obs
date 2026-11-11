/**
 * @fileoverview Bounded shutdown for the metrics/logs signal lanes (Bug 46). The OTel SDK's
 * provider.shutdown() waits out the exporter's own HTTP timeout — 136 s measured against a
 * blackholed endpoint — so an unload would hang the host. Same class as the sender's
 * drainBudgetMs/closeBudgetMs: an unconditional baseline bound, not a fastShutdown shortcut.
 */

// Budget arithmetic (Bug 46, keeps the README's ~1.5 s unload promise true): the sender lane
// is 1 s drain + 0.5 s close = 1.5 s. index.ts runs the metrics and logs shutdowns concurrently
// with that lane, each under this 500 ms bound, so the unload bound stays max(1.5 s, 0.5 s) =
// 1.5 s rather than 1.5 s + 0.5 s + 0.5 s. Blast radius: a sample/log batch still in flight at
// the bound is dropped, never retried.
export const SIGNAL_SHUTDOWN_BUDGET_MS = 500

/** Await `work`, but never longer than `budgetMs`; a timeout logs and resolves so unload never hangs */
export async function shutdownWithin(
  label: string,
  budgetMs: number,
  work: () => Promise<void>,
  log: (msg: string, data?: unknown) => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), budgetMs)
    timer.unref?.() // an unref'd timer cannot keep the host alive on its own
  })
  try {
    // The catch is attached here so a sync throw or a late rejection from the abandoned shutdown
    // is contained, never unhandled
    const settled = await Promise.race([Promise.resolve().then(work).catch(() => "failed" as const), expired])
    if (settled === "expired") log(`${label} shutdown exceeded ${budgetMs}ms budget, abandoning`)
  } finally {
    clearTimeout(timer)
  }
}
