# Governance register

Current standing record of the semantic heuristics this plugin runs on and their known
limitations — governing records, not roadmap items. A heuristic is retired only when its
migration condition is met (and the compaction one is id-frozen, see below). Adjudications
and dated decisions live in [decisions.md](decisions.md); the policy itself is
AGENTS.md §"Heuristic policy: upstream contracts come first".

## Standing heuristics (labeled)

Standing semantic heuristics approved per the AGENTS.md "Heuristic policy" (upstream
contracts come first): each is labeled `HEURISTIC(upstream-gap)` where it lives in
`src/spans.ts`.

| Site (path:line) | Invented semantics | Upstream gap | Upstream issue | Migration condition | Approved |
| --- | --- | --- | --- | --- | --- |
| `src/spans.ts:230` | Compaction run identity = the started event's ms timestamp (`CompactionState.key`) | `session.compaction.started/ended` carry only {sessionID, reason}; ended never references its started; no run id exists. Key is FROZEN — it feeds the `opencode-compaction:<sid>:<created>` id formulas, so changing it changes all future span ids | — | Upstream adds a run/correlation id (any key change before that needs an explicit id-continuity decision) | user decision 2026-11-01; adjudicated keep — user decision 2026-11-02 |
| `src/spans.ts:680` | Turn identity only: turn root keyed `auto:<created>` when `step.started` arrives with no stashed prompt. The fabricated user message `"(auto)"` and its four attribution leaks (`gen_ai.user.message` log event, `input.value`, name preview, `opencode.user_prompt.length` = 6) were REMOVED in Bug 25 — wakeup text now comes from the real synthetic events, and the turn root carries `opencode.turn.wakeup` = `synthetic`/`unknown` | No marker ties an execution round to its wakeup: the round-opening `step.started` carries no origin. The synthetic events DO fire (v2 source + live probe `/tmp/opencode/syn-probe.jsonl`): subagent-completion wakeup (synthetic `session.inbox.enqueued` item), `Session.synthetic` external route, restart continuation (`restart.ts:93`), instruction injection (`instructions.ts:75`), stream continuation (`llm.ts:333,364`). The earlier "never fires" claim (2026-11-01 probe) was a probe artifact — those paths were not exercised | [#47701](https://github.com/anomalyco/opencode/issues/47701) | Upstream documents a round-origin marker correlating `step.started` with its wakeup event | user decision 2026-11-01 (turn identity); attribution fabrication removed in Bug 25 — mechanism-aligned, real events consumed |
| `src/spans.ts:393` | "An interrupted step may still deliver a late `step.ended`" — mark-not-delete design (`interrupted` flag) rested on it. Adjudicated 2026-11-03: assumption REFUTED for live ordering — upstream publishes step terminals inside an uninterruptible block (`runner/step.ts:140-283`, `Step.Ended` at `:247-258`) and `execution.interrupted` only afterwards, from the coordinator's settled hook (`execution.ts:129-133`, `run-coordinator.ts:96-100`), so live `step.ended` ALWAYS precedes interrupted; the sole no-terminal interrupt path is cancellation before the assistant started (`step.ts:147-148`) — the mark branch never fires in live operation | No documented delivery contract for step terminals relative to `session.execution.interrupted`; source ordering now verified as above | — | None for live; retire the mark branch only by explicit user decision | user decision 2026-11-01; adjudicated keep — user decision 2026-11-03 (retained as cheap gap/replay defense: bounded ~20 lines, tested, no live-path branching cost beyond the dual-mode purge; a consciously-accepted exception to AGENTS.md "live capture first") |
| `src/spans.ts:960` | Reasoning segments concatenate in ARRIVAL order; never a fabricated interleaving with text parts. Adjudicated 2026-11-03: live ordering VERIFIED — the bus preserves per-subscription publish order (`bus.ts:751-782`), so in live capture arrival order equals generation order; the no-ordinal gap matters only for replay lanes | Text segments carry a protocol ordinal; reasoning events carry no ordinal/index — concatenation order has no contract guarantee (live delivery verified ordered; replay lanes still unguaranteed) | — | Upstream adds an index to reasoning segments | user decision 2026-11-01; adjudicated keep — user decision 2026-11-03 |

## Known limitations

Known limitation (heuristic #1, verified 2026-11-02): the compaction run registry is
in-memory single-open-run state, so a plugin restart between `session.compaction.started`
and `session.compaction.ended/failed` finds no run to pair with — the terminal handler
returns before emitting (`src/spans.ts:717`), dropping the span entirely, not degraded:
the ended event's model/tokens/cost/text reach no span (a bare reason+start-time span
only ever comes from a recorded start, via predecessor flush or graceful `flushAll`).
Upstream ask: compaction started/ended carry no run id and ended does not reference its
started — candidate [#47701](https://github.com/anomalyco/opencode/issues/47701)
follow-up material (external post requires user approval).

Known limitation (Bug 23 guard boundaries, accepted 2026-11-03): two behaviors of the
durable.seq stale-terminal guard are accepted as-is — both upstream gaps (no round id in
the event envelope). First, a stale old-round terminal's error payload is discarded by
design: the guard (`src/spans.ts:559`) mutates nothing, so the superseded round's failure
reason never lands on any span; surfacing it would require an upstream round
discriminator. Second, the no-seq degrade path: when `durable.seq` is absent (older
hosts), a late terminal still flushes the current turn early and the new round's chat span
is lost — pinned by the Bug 23 fallback test (`tests/spans.test.ts:838`) as the documented
pre-Bug-23 behavior.

Known limitation (S4, record-only per user decision 2026-11-03): a `session.renamed`
arriving before the session is registered — plugin mid-attach (missed `session.created`)
or post-eviction — is dropped from the sessions registry: the guard (`src/spans.ts:588`)
only mutates cached state. Recovery: the turn/container flush refreshes the title live
via `getSessionInfo` (`ctx.session.get` returns the post-rename title), and the
annotation lane uses the event data directly. Residual risk (accepted, record-only):
the title is missing ONLY when mid-attach + rename + flush-time `ctx.session.get`
failure coincide — the name falls back to the prompt preview/`"(empty)"`; degraded,
never wrong data. Rationale: live-capture-first principle — a stash table for this
triple coincidence is not worth main-path complexity.

Known limitation (Bug 32 accounting semantics, accepted 2026-11-03): in-flight tool
state is retained across round close with a round-bound `traceId` (`ToolState.traceId`,
stamped at creation and backfilled at round close before the flush), so a late tool
terminal emits with its original name/duration/attribution — but the round's
already-flushed `opencode.turn.messages` cannot retroactively count it (the turn root
is a snapshot at flush time), and a late old-round terminal never counts on the newer
round's root (traceId-guarded accounting). Unload `flushAll` emits unsettled tools as
`interrupted: plugin_unload` and counts each on its own still-open turn's root; the
registry is bounded by MAX_IN_FLIGHT_TOOLS (1024, oldest-first eviction, degraded
terminal for the evicted call — never a fabricated span).
