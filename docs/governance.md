# Governance register

Current standing record of the semantic heuristics this plugin runs on and their known
limitations — governing records, not roadmap items. A heuristic is retired only when its
migration condition is met (and the compaction one is id-frozen, see below). Adjudications
and dated decisions live in [decisions.md](decisions.md); the policy itself is
AGENTS.md §"Heuristic policy: upstream contracts come first".

## Standing heuristics (labeled)

Standing semantic heuristics approved per the AGENTS.md "Heuristic policy" (upstream
contracts come first): each is labeled `HEURISTIC(upstream-gap)` where it lives in
`src/spans.ts` / `src/wire.ts`. Anchors are **symbols**, not line numbers — line
numbers rot on every unrelated edit (this table's four original `path:line` anchors had
three stale entries by 2026-11-11).

| Site (path · symbol) | Invented semantics | Upstream gap | Upstream issue | Migration condition | Approved |
| --- | --- | --- | --- | --- | --- |
| `src/spans.ts` · `CompactionState.key` | Compaction run identity = the started event's ms timestamp (`CompactionState.key`) | `session.compaction.started/ended` carry only {sessionID, reason}; ended never references its started; no run id exists. Key is FROZEN — it feeds the `opencode-compaction:<sid>:<created>` id formulas, so changing it changes all future span ids | — | Upstream adds a run/correlation id (any key change before that needs an explicit id-continuity decision) | user decision 2026-11-01; adjudicated keep — user decision 2026-11-02 |
| `src/spans.ts` · `handleEvent` (step.started auto branch, opens via `openTurn`) | Turn identity only: turn root keyed `auto:<created>` when `step.started` arrives with no stashed prompt. The fabricated user message `"(auto)"` and its four attribution leaks (`gen_ai.user.message` log event, `input.value`, name preview, `opencode.user_prompt.length` = 6) were REMOVED in Bug 25 — wakeup text now comes from the real synthetic events, and the turn root carries `opencode.turn.wakeup` = `synthetic`/`unknown` | No marker ties an execution round to its wakeup: the round-opening `step.started` carries no origin. The synthetic events DO fire (v2 source + live probe `/tmp/opencode/syn-probe.jsonl`): subagent-completion wakeup (synthetic `session.inbox.enqueued` item), `Session.synthetic` external route, restart continuation (`restart.ts:93`), instruction injection (`instructions.ts:75`), stream continuation (`llm.ts:333,364`). The earlier "never fires" claim (2026-11-01 probe) was a probe artifact — those paths were not exercised | [#47701](https://github.com/anomalyco/opencode/issues/47701) | Upstream documents a round-origin marker correlating `step.started` with its wakeup event | user decision 2026-11-01 (turn identity); attribution fabrication removed in Bug 25 — mechanism-aligned, real events consumed |
| `src/spans.ts` · `purgeInFlight` | "An interrupted step may still deliver a late `step.ended`" — mark-not-delete design (`interrupted` flag) rested on it. Adjudicated 2026-11-03: assumption REFUTED for live ordering — upstream publishes step terminals inside an uninterruptible block (`runner/step.ts:140-283`, `Step.Ended` at `:247-258`) and `execution.interrupted` only afterwards, from the coordinator's settled hook (`execution.ts:129-133`, `run-coordinator.ts:96-100`), so live `step.ended` ALWAYS precedes interrupted; the sole no-terminal interrupt path is cancellation before the assistant started (`step.ts:147-148`) — the mark branch never fires in live operation | No documented delivery contract for step terminals relative to `session.execution.interrupted`; source ordering now verified as above | — | None for live; retire the mark branch only by explicit user decision | user decision 2026-11-01; adjudicated keep — user decision 2026-11-03 (retained as cheap gap/replay defense: bounded ~20 lines, tested, no live-path branching cost beyond the dual-mode purge; a consciously-accepted exception to AGENTS.md "live capture first") |
| `src/spans.ts` · `emitChatSpan` | Reasoning segments concatenate in ARRIVAL order; never a fabricated interleaving with text parts. Adjudicated 2026-11-03: live ordering VERIFIED — the bus preserves per-subscription publish order (`bus.ts:751-782`), so in live capture arrival order equals generation order; the no-ordinal gap matters only for replay lanes | Text segments carry a protocol ordinal; reasoning events carry no ordinal/index — concatenation order has no contract guarantee (live delivery verified ordered; replay lanes still unguaranteed) | — | Upstream adds an index to reasoning segments | user decision 2026-11-01; adjudicated keep — user decision 2026-11-03 |
| `src/spans.ts` · `childTraceSource` (orphan branch) | Trace identity for a sub-agent round with neither an attachment link nor an open parent turn (`orphanTraceId(childSessionID)`). Never merged with the parent's trace: the round stays internally consistent (container + chat + tool in one trace, Bug 49) at the cost of being disconnected from the parent trace | `session.created` publishes the child's `parentID` but no trace/parent-span id, and the delegating tool's terminal (the only event naming the child session) can arrive before or after the child's first `step.started`, so a sub-agent that starts first has nothing to inherit | [#47701](https://github.com/anomalyco/opencode/issues/47701) | Upstream publishes the parent trace/span identity on the child session (or orders the delegating tool terminal before the child's first step) | user decision 2026-11-11 (fix order approved; consistent-trace rule chosen over a dangling parent reference) |
| `src/wire.ts` · `consumePending` (label) / `src/spans.ts` · `emitChatSpan` (`options.consumeWire` call) | Wire→chat-span ATTRIBUTION: the oldest unconsumed `kind === "primary"` frame per session is attached to whichever chat span emits next — positional inference from a side channel, no per-frame correlation. Blast radius: any step producing no frame (retry, non-wire provider, PENDING_CAP drop) shifts later frames by one, silently attaching another step's request body; trace/span ids are unaffected, only the body | The OpenCode event stream publishes no request→step correlation id, and the wire hook carries no step identifier — a frame cannot name the step it belongs to | — | Upstream adds a request/step correlation id to the event stream (or the wire hook) | user decision 2026-11-11 (review report reviewed and fix order approved; fallback policy stays "attach oldest frame") |

## Known limitations

Known limitation (heuristic #1, verified 2026-11-02): the compaction run registry is
in-memory single-open-run state, so a plugin restart between `session.compaction.started`
and `session.compaction.ended/failed` finds no run to pair with — the terminal handler
returns before emitting (`src/spans.ts` · `handleEvent`, the `session.compaction.ended`/
`session.compaction.failed` case: `if (!state) return`), dropping the span entirely, not
degraded: the ended event's model/tokens/cost/text reach no span (a bare reason+start-time
span only ever comes from a recorded start, via predecessor flush or graceful `flushAll`).
Upstream ask: compaction started/ended carry no run id and ended does not reference its
started — candidate [#47701](https://github.com/anomalyco/opencode/issues/47701)
follow-up material (external post requires user approval).

Known limitation (Bug 23 guard boundaries, accepted 2026-11-03): two behaviors of the
durable.seq stale-terminal guard are accepted as-is — both upstream gaps (no round id in
the event envelope). First, a stale old-round terminal's error payload is discarded by
design: the guard (`src/spans.ts` · `staleTerminal`) mutates nothing, so the superseded
round's failure reason never lands on any span; surfacing it would require an upstream
round discriminator. Second, the no-seq degrade path: when `durable.seq` is absent (older
hosts), a late terminal still flushes the current turn early and the new round's chat span
is lost — pinned by the Bug 23 fallback test (the test titled "Bug 23 fallback: without
durable.seq a late terminal still flushes the new turn early") as the documented
pre-Bug-23 behavior.

Known limitation (S4, record-only per user decision 2026-11-03): a `session.renamed`
arriving before the session is registered — plugin mid-attach (missed `session.created`)
or post-eviction — is dropped from the sessions registry: the guard (`src/spans.ts` ·
`handleEvent`, `session.renamed` case) only mutates cached state. Recovery: the
turn/container flush refreshes the title live
via `getSessionInfo` (`ctx.session.get` returns the post-rename title), and the
annotation lane uses the event data directly. Residual risk (accepted, record-only):
the title is missing ONLY when mid-attach + rename + flush-time `ctx.session.get`
failure coincide — the name falls back to the prompt preview (when prompt capture is
on) or the opaque `turn <userMessageID>` identity (Bug 47); degraded, never wrong data.
Rationale: live-capture-first principle — a stash table for this
triple coincidence is not worth main-path complexity.

Known limitation (wire→span FIFO attribution, accepted 2026-11-11): the FIFO heuristic
(see the table above) cannot detect that a frame is missing, so there is no degrade
signal to surface — a shifted queue misattributes silently. The PENDING_CAP (8 frames
per session) bound is the only mechanical limit: past it the oldest unconsumed frame is
dropped, which both discards a body and guarantees the next chat span reads a stale one.
Fallback policy stays "attach the oldest frame" (never fabricate a body, never leave a
consumed-but-unattached frame in the queue) — an explicit user decision, recorded with
the fix order approval. Revisit only when upstream publishes a request/step correlation
id; until then any new call site consuming frames must reuse `consumePending`, not
extend the heuristic on its own.

Known limitation (sub-agent orphan rounds, accepted 2026-11-11): a round that opened before
its parent turn existed (see the `childTraceSource` row above) lands in its own trace rooted at
the `invoke_agent` container, disconnected from the parent's trace — a viewer sees two traces
instead of one tree. Preferring this over attachment is deliberate: the parent trace id is
unknown at that moment, and inventing one would merge unrelated work. The round is internally
consistent by construction — container, chat and tool spans all resolve through the
container's frozen `traceId` (Bug 49) — so no span ever names a `parentSpanId` that lives in
another trace. If the parent turn opens later, its delegating tool span and the child round
share no trace; correlation is still possible via `opencode.session.parent_id`.

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
