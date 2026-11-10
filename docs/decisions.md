# Decision log

Append-only, dated log of governance decisions and adjudications. The current standing
record (labeled heuristics, known limitations) lives in [governance.md](governance.md);
the policy itself is AGENTS.md §"Heuristic policy: upstream contracts come first".

## Governance log

- 2026-10-28: metrics + opt-in logs/events lanes shipped (`e1e80c6`, `968da38`) —
  gen_ai.client.token.usage + gen_ai.client.operation.duration metrics; logs lane events
  gen_ai.user.message / system.message / tool.message / choice (historical
  assistant-input events are not emitted; these event names are deprecated). Every event
  carries the deterministic span context of its origin span for log ↔ trace joins; gated
  content emits metadata-only events.
- 2026-11-01: Full-project review surfaced 10 bugs (Bugs 16-22 fixed red-first) and a
  governance gap → heuristic policy adopted in AGENTS.md (`2be1436`): no invented
  identity/ordering/attribution without an explicit user decision; standing heuristics
  must be labeled. Four standing heuristics labeled in code (`HEURISTIC(upstream-gap)`
  ×4, `6203b46`) and indexed here.
- Bug 23 (`0bd2f48`) set the pattern: a proposed heuristic fix (timestamp guard /
  superseded-reason routing) was retracted in favor of the upstream mechanism
  (durable.seq) once the contract was verified.
- 2026-11-03: "Live capture first" principle — live capture is primary; no live-path
  complexity for replay-only anomalies (AGENTS.md, `3776970`).
- Bug 32 (2026-11-03): late/unload-race tool terminal loss — in-flight tool state is
  retained across round close with a round-bound traceId (name/duration/attribution
  survive late terminals and round takeovers); round accounting is traceId-guarded so
  an old-round terminal never inflates the current round; unload flushAll emits
  in-flight tools as `interrupted: plugin_unload` (closes the measured host-restart
  window: plugin "unloaded" → parent tool settles 17ms later, span previously lost).
- One-by-one adjudication of all four standing heuristics, each grounded in upstream
  source verification (`~/yzh/code/temp/opencode`; upstream citations verified against
  v2.2.5) and live probes:
  - #1 compaction timestamp identity — KEEP; restart limitation recorded (`4e2737e`);
    adjacent hazard fixed as Bug 24 (`3420b7c`, durable.seq guard).
  - #2 auto-turn fabricated attribution — REMOVED; real wakeup events consumed
    (`opencode.turn.wakeup`, Bug 25 `51875d8`) + stale-wake hardening (Bug 26
    `e221669`); S2 closed.
  - #3 interrupted-step marking — KEEP, zero code change; assumption verified against
    upstream ordering, retained as an accepted gap/replay exception (`ba89f60`).
  - #4 reasoning arrival-order — KEEP, zero change; live ordering verified (`ba89f60`).
- 2026-11-03: audit item ① adjudicated (user decision, option B):
  `opencode.interrupt.reason` is host-enum-only; unload teardown does not set it (the
  `plugin_unload` cause stays in the status message) — Bug 34 (`6a455a0`).
- Closing pattern: policy → labels → per-item adjudication → every outcome is either a
  mechanism-aligned fix or a verified archive entry; nothing stays a guess.
- Bug 38 (2026-11-08, external PR #1 by dervism): bounded shutdown when the OTLP backend
  is unreachable — drain() pre-probes the endpoint (150 ms TCP connect) and drops the queue
  at once when nothing listens; in-flight send and final flush share a 1 s budget, close()
  gets 0.5 s; a backend whose last export failed is not retried at shutdown (`5dee1d2`).
- 2026-11-09: `tracing.fastShutdown` gate (Bug 38 follow-up, `339252b`) — the
  spec-mandated bounds (drain/close budgets, bounded final flush) stay unconditional; the
  CLI fast-fail shortcuts (150 ms pre-drain TCP probe, skip after a failed export) are
  gated by `tracing.fastShutdown` (config, default true). Principle codified as AGENTS.md
  §"Spec baselines vs. CLI-ergonomic optimizations".
- 2026-11-09: `tracing.agentName` template (closes #2, `dbadfea`) — `gen_ai.agent.name`
  default changed from the bare role name to `opencode/{agent}`, applied to turn roots,
  sub-agent tool spans, and sub-agent containers (NOT chat spans — semconv scopes the
  agent name to agent-operation spans; see docs/semconv-mapping.md). `"{agent}"` restores
  the old value; the ungated raw mirror `opencode.agent` is always present; `""` omits
  only `gen_ai.agent.name`.
- 2026-11-10: Bug 39 (user decision A+B) — annotation-backfill noise: (A) the startup
  backfill annotates only sessions the plugin knows have exported ≥1 span, tracked in a
  new plugin-owned state file `~/.local/share/opencode/ocg-obs-exported-sessions.json`
  (`OCG_OBS_EXPORTED_SESSIONS` overrides the path; `{"exported":[…]}`, FIFO cap 8192,
  atomic tmp+rename write, missing/corrupt ⇒ empty — bootstrap: the first post-upgrade
  backfill annotates ~nothing, old Phoenix rows already carry their labels); the mark
  hooks the shared span-emit callback in index.ts, which every span kind funnels
  through. (B) the backfill annotates with zero retries (single attempt). Live
  event-driven annotation (created/renamed immediate, post-terminal +3 s) is unchanged
  and keeps its 3-attempt retry — that 404 race self-heals by design. Also fixes a
  latent logger bug the new log-file test assertions surfaced: a queued append failing
  against a file whose sink was already replaced no longer degrades the active sink.
