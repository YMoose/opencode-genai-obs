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
- 2026-11-10: Bug 33 fixed (user approved after risk review) — an `endedTools` guard at
  the tool-start re-creation entry drops a redelivered `session.tool.input.started` for a
  callId whose terminal already emitted, logging one drop line. Contract basis: verified
  bus semantics — a redelivery is the same event resent, never a new execution —
  extending the assumption `endedTools` already enforces terminal-side (Bug 16) to the
  start side. Eliminates the phantom `interrupted: plugin_unload` span under the wrong
  round's trace and that turn's `opencode.turn.messages` inflation at unload; blast
  radius: a host reusing a callId for a genuinely new execution loses that start cleanly
  (wrong data → no data). The replay-only stamping variant (`stampInFlightTools` stamping
  unstamped old-round tools by session) stays recorded-only per live-capture-first.
  endedTools cap review: registry is UNBOUNDED (one string per tool call, per session
  lifecycle; session.deleted is the only purge, session-registry eviction does not
  remove a victim's set) — growth trait documented at the declaration, cap left for
  separate adjudication.
- 2026-11-10: Bug 33 follow-up fixed — the `session.tool.called` re-creation entry gets
  the same `endedTools` guard as the started entry (Bug 33): a redelivered `tool.called`
  for a callId whose terminal already emitted is dropped with one log line. Same
  contract basis as Bug 33 (a redelivery is the same event resent, never a new
  execution, extending the Bug 16 terminal-side idempotency to the called side);
  without the guard the branch re-created zombie ToolState under the current round's
  live traceId, emitted as a phantom `interrupted: plugin_unload` span at unload
  flushAll while the redelivery's own terminal was already dropped by Bug 16.
- 2026-11-10: Bug 40 fixed (user decision "驱逐时清") — registry-cap eviction now purges
  the victim's `endedTools` set: eviction is forgetting the session, consistent with
  the re-registration degradation an evicted session already suffers; without the
  purge, an evicted-but-undeleted session's set lingered forever. A numeric
  per-session/per-set cap was considered and DECLINED by user decision (2026-11-10) —
  a registered session's set is its terminal history and grows by design. Growth-trait
  comment at the declaration updated accordingly. Same-trait recon (report-only):
  `endedSteps` (spans.ts) and `postSpanAnnotated` (index.ts) still linger past
  eviction; `pendingWakes` lingers only for an unconsumed wake; `postSpanTimers`
  self-heals when the timer fires — left for later adjudication.
- 2026-11-10: Bug 40 follow-up "evict-forget sweep" fixed (user decision "全清"
  2026-11-10) — full-family application of the eviction=forgetting ruling to the three
  remaining evict-linger collections from the Bug 40 recon: registry-cap eviction now
  also purges the victim's `endedSteps` set (the larger-magnitude twin: one string per
  step vs per tool call) and `pendingWakes` entry (spans.ts, at the victim-removal
  site), and a new synchronous `onSessionEvicted` factory option notifies index.ts to
  drop `postSpanAnnotated[sid]` and cancel/clear a pending `postSpanTimers` entry —
  exceptions from the hook are swallowed and logged, so a throwing subscriber can never
  break the live event path. The pendingWakes purge also closes a small
  misattribution path: a lingering wake could be consumed by the session's next round
  after re-registration, attaching stale wakeup text (`opencode.turn.wakeup` +
  `input.value`) to a turn root it never woke. `postSpanTimers` already self-heals
  when the timer fires; the cancel is belt-and-suspenders (promptness, no stray POST
  after eviction).
- 2026-11-10: Bug 41 (semconv gap #1, user decision: dual-emit transition) —
  cache-write tokens now emit the standard `gen_ai.usage.cache_creation.input_tokens`
  (verified in @opentelemetry/semantic-conventions 1.43.0; no `cache_write` variant
  exists) on both chat and compaction spans, alongside the legacy self-invented
  `gen_ai.usage.cache_write.input_tokens` with the same value. The legacy key is
  retained temporarily for existing dashboards; its removal is deferred to a future
  release decision. `gen_ai.usage.cache_read.input_tokens` was already
  standard-conformant and is untouched.
- 2026-11-10: Bug 42 (semconv gap #2, user decision option A: one-time breaking type
  change, no mirror/transition — one-field-one-source) —
  `gen_ai.response.finish_reasons` now emits as a true `string[]` attribute
  (`[finish]`; previously a JSON-encoded string like `'["stop"]'`). `AttrValue`
  (src/otlp.ts) widened with flat homogeneous scalar-array branches mirroring
  @opentelemetry/api's `AttributeValue`, so the adapter passes arrays through
  uncast. Transformer probe on the pinned otlp-transformer 0.219.0: `toAnyValue`'s
  `Array.isArray` branch precedes its `Object.keys` branch, so the NATIVE arrayValue
  path was used — no manual construction needed. The exact protobuf byte signature
  (key + KeyValue wrapper + arrayValue{values:[{stringValue}]}) is pinned in
  tests/otlp.test.ts (Bug 28 precedent) so a future dependency bump cannot silently
  regress arrays into a kvlist with numeric keys.
- 2026-11-10: Bug 43 (semconv gap #3, user decision "A + B 记档": stop emitting now,
  record the wire-derived option as conditional backlog) — chat and compaction spans no
  longer emit `gen_ai.response.model`; it duplicated the requested `model.id`, a false
  implication of provider confirmation (data-honesty: fake confirmation is worse than
  absence — same family as the Bug 25 "(auto)" fabricated-user-message removal).
  `gen_ai.request.model` is untouched: the requested identity is genuinely observed.
  Option B (derive the served model identity from the wire capture, e.g. Anthropic's
  response `model` field) is recorded in TODO.md as a conditional backlog item
  (trigger: alias-vs-served-model comparison needed; provider-specific parsing and
  timing coupling noted there).
- 2026-11-10: semconv gap #4 adjudicated record-only — chat duration keeps the current
  step wall-clock measurement (settlement included); the `session.step.streamed`
  provider-boundary marker stays unconsumed; TTFT declined. Facts and future-fix
  prerequisites preserved in TODO.md (semconv gaps list).
- 2026-11-10: semconv gap #5 adjudicated record-only — truncated JSON-valued attributes
  (`input.value`+`input.mime_type`, `gen_ai.output.messages`, tool
  `gen_ai.tool.call.result`/`output.value`) keep the prefix+marker form; the four
  representation alternatives (degrade-to-text / structural trim / sentinel object /
  clean omission) were evaluated and declined. Rationale and re-evaluation trigger
  preserved in TODO.md (semconv gaps list).
- 2026-11-10: semconv gap #6 adjudicated record-only — the four legacy log event names
  (`gen_ai.user.message`/`system.message`/`tool.message`/`choice`) stay despite
  semantic-conventions 1.43.0 `@deprecated` status; migration options and re-evaluation
  triggers preserved in TODO.md (semconv gaps list).
- 2026-11-11: Bug 47 fixed — the turn-root span name took a 40-char prompt preview and
  bypassed every content gate (with all five off it still shipped the raw prompt text).
  The name is content and now answers to `contentGates.userPrompts` + a non-zero
  `contentMaxLength`; when gated it degrades to the opaque `turn <userMessageID>`, and a
  positive budget bounds the preview to the same byte count. The session title is
  deliberately not the gated fallback (hosts generate it FROM the prompt). Documented in
  docs/semconv-mapping.md §2 and both READMEs' gate rows.
- 2026-11-11: wire→span FIFO attribution labeled and registered (review report reviewed,
  fix order approved): the oldest unconsumed `kind === "primary"` frame per session is
  attached to whichever chat span emits next. The OpenCode event stream publishes no
  request→step correlation id, so this is positional inference from a side channel.
  Decision: KEEP the FIFO attribution; fallback policy stays "attach the oldest frame"
  (never fabricate a body, never leave a consumed frame unattached). Blast radius
  accepted: any step producing no frame (retry, non-wire provider, PENDING_CAP drop)
  shifts later frames by one, silently misattributing bodies — trace/span ids are
  unaffected. Labeled at `src/wire.ts` · `consumePending` (full label) and
  `src/spans.ts` · `emitChatSpan` (pointer); governance.md gains the standing-heuristic
  row and a known-limitations entry, and its table anchors switch from rot-prone line
  numbers to symbol names.
- 2026-11-11: Bug 48 fixed — stop fabricating semconv attribute values. Bug 43 removed
  `gen_ai.response.model` under the data-honesty rule ("fake confirmation is worse than
  absence"); the same rule now applies to the placeholders left behind elsewhere:
  `gen_ai.request.model` is omitted when the step event carried no model id (was
  `"unknown"`, and the span name degrades to the bare `chat`); `gen_ai.tool.name` is
  omitted when no start/called event was observed (was `"unknown"`; span name degrades to
  `execute_tool`); `gen_ai.tool.type` is no longer emitted at all (the constant
  `"function"` was a guess that mislabels `datastore`/`extension` tools); and
  `gen_ai.provider.name` no longer carries the constant `"opencode"` on turn roots and
  sub-agent containers — that slot is the *inference* provider
  (`openai`/`anthropic`/…), and semconv uses it as the discriminator for
  provider-specific attribute flavors, so a framework name there reads as a provider that
  does not exist. Framework identity stays on `service.name` and `gen_ai.agent.name`.
  Requirement-level notes: `gen_ai.request.model`, `gen_ai.tool.type` are
  `Conditionally Required`/`Recommended` "*If available*" — omission is conformant;
  `gen_ai.tool.name` and (on `invoke_agent`) `gen_ai.provider.name` are `Required`, so
  those two are conscious deviations: an absent value is a gap a reader can see, a
  fabricated one is a claim they cannot detect. The metrics/logs lanes follow the same
  rule (an unobserved `gen_ai.provider.name`/`gen_ai.request.model`/tool name is omitted
  rather than sent empty).
- 2026-11-11: Bug 49 fixed — a sub-agent round can no longer straddle two traces. The
  round's trace identity was re-resolved on every emission (`childTrace` re-read the live
  link / parent open turn), while the chat and tool spans froze theirs at creation. A
  link or parent turn that appeared mid-round therefore moved only the container: the
  chat span landed in the parent trace with a `parentSpanId` naming the container, and
  the container landed in the fabricated orphan trace — a dangling parent reference, a
  parent claim no backend can resolve. The container now freezes its `traceId` when the
  round opens (`containers.traceId`), the sub-agent twin of `TurnState.traceId`, and all
  of the round's spans resolve through it; a link naming a different trace is not used
  as `parentSpanId` (omitted rather than asserted). Consistent with the Bug 43/48
  data-honesty rule: a dangling parent reference is a fabricated claim. The remaining
  orphan-trace fabrication (a child that starts before its parent turn exists) is now
  labeled `HEURISTIC(upstream-gap)` at `childTraceSource`, registered in
  docs/governance.md with a standing-heuristic row and a known-limitations entry:
  upstream publishes the child's `parentID` but no trace/parent-span id, and the
  delegating tool terminal can arrive before the child's first step.
