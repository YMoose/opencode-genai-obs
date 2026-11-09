# AGENTS.md

Guidelines for agents working in this repository.

## Project

opencode-genai-obs (`ocg-obs`): an OpenCode v2 plugin providing GenAI-semconv OTLP tracing
(real-time lane) plus raw LLM wire-body capture, aligned with OTel GenAI semconv + OpenInference
only — never bound to a specific observability platform. Signals are GenAI-semconv-scoped:
traces under `gen_ai.*`; metrics limited to `gen_ai.client.*`; events limited to the five
`gen_ai.*` message events. No infra/runtime metrics, no app-ops dashboard metrics, no
general log piping. The OTLP protobuf encoding is delegated to the official @opentelemetry
SDK (pinned closure: api / api-logs / core / resources / sdk-metrics / sdk-logs /
sdk-trace-base / the three OTLP proto exporters + jsonc-parser); zero new test
dependencies (`node:test` + `node:assert`).

## Layout

- `src/index.ts` — plugin entry: hook registration, owner election/re-election (globalThis
  pipeline singleton shared across opencode's per-location module realms)
- `src/config.ts` — env/config loading and validation (env > config file > defaults)
- `src/spans.ts` — event → span state machine (turns/steps/tools/compaction/retry)
- `src/ids.ts` — the FROZEN deterministic-id contract (byte-identical to the internal
  offline replay lane; never change published formulas — tests/ids.test.ts pins exact
  outputs, and drift silently breaks offline-replay dedup)
- `src/otlp.ts` — OTLP/HTTP export via the official OTLPTraceExporter; adapts our
  SpanRecord (deterministic ids) to ReadableSpan. The pipeline deliberately uses the
  exporter alone (no BasicTracerProvider): the SDK IdGenerator takes no arguments and
  cannot express the deterministic-id contract
- `src/metrics.ts` — gen_ai.client.* metrics (token usage + operation duration), private
  MeterProvider
- `src/logs.ts` — opt-in gen_ai.* message events (user/system/tool/choice) via sdk-logs;
  assistant.message folds into choice; span context joins log ↔ trace
- `src/sender.ts` — send queue with retry/backoff and drain-on-dispose
- `src/probe.ts` — one-shot startup TCP probe of the configured OTLP endpoints
  (log-only diagnostics; never called in wire-only mode)
- `src/wire.ts` — wire-body JSONL capture (`experimental.ws.send` + `http.request` hooks)
- `src/annotations.ts` — Phoenix-compatible session annotations (toggleable extension)
- `src/redact.ts`, `src/logger.ts`, `src/types.ts` — redaction, file logger, shared types
- `tests/` — `node:test` suite; `tests/helpers.ts` has the mock infrastructure

## Commands

```bash
npm run typecheck   # tsc -p tsconfig.json --noEmit
npm test            # tsc -p tsconfig.test.json && node --test dist-test/tests/*.test.js
npm run build       # compile src/ → dist/
```

Node 25 does not support directory arguments for `node --test`; the glob is required.

## Bug-fix rule (mandatory)

Every bug fix lands with an accompanying test:

- Write the test first and confirm it fails against the unfixed code (red), then fix and
  confirm green. The commit that fixes a bug must contain its test.
- Continue the `Bug N` numbering in test titles (currently Bug 1–38); cite the upstream origin
  in the title when one exists (e.g. `Bug 9 (same as opencode #55002)`).
- The test must assert the observable behavior that was wrong, not just that code ran.

## Testing conventions

- Test titles, assertion messages, and code comments are English.
- globalThis keys `__ocgObsPipeline$` / `__ocgObsPipelineGen$` are shared process state: tests
  that install them must clean up via `t.after(...)`, or they contaminate the whole file.
- Config tests: use `snapshotEnv`/`restoreEnv`/`tempDir` from `tests/helpers.ts` (see
  `loadFrom` in `config.test.ts`); never leak env or touch the user's real config path.

## Style

- Google TypeScript Style Guide is the reference; semantic rules are enforced. Adopted
  deviations (do not "fix" these): no semicolons, double quotes, brace-less single-statement
  `if`s, ~100-120 col lines, arrow-function consts inside factory closures.
- Comments in English, "why" only — delete comments that restate the code.
- CONSTANT_CASE is only valid at module level; function-scoped constants use lowerCamelCase.
- `export default` in `src/index.ts` is required by the opencode plugin host — keep it.
- Non-null assertions need either a restructure that removes them or a `// Safe:` comment.

## Borrowing from other projects

We are grateful to adjacent open-source projects (DEVtheOPS/opencode-plugin-otel,
Claude Code's monitoring docs, Phoenix, …) for openly sharing their designs and hard-won
lessons — their work is a genuine source of learning for this project. When we adopt an
idea, the rules are:

- Open ideas deserve respect and credit. Understand why the other project does something
  before adopting it — if you can't explain the why in your own words, don't port it.
  Re-derive the design against our context (audit-oriented, deterministic IDs,
  platform-neutral, minimal dependencies) instead of importing their solution wholesale.
- Respect the license boundary. Never copy code verbatim or near-verbatim:
  opencode-plugin-otel is MPL-2.0 while this repo is MIT, and a copied file would carry
  MPL-2.0 into the project. Re-implement from understanding, in our own style —
  everything in the Style and Testing conventions sections applies in full.
- Credit the source in the commit message body (`Inspired by …`, `Adapted from …`) so
  the lineage stays traceable and their contribution is acknowledged.

## Heuristic policy: upstream contracts come first

This plugin projects two upstream contracts: the opencode event stream and the OTel
GenAI semconv. When a contract is silent or ambiguous about something we need, the
temptation is to invent the missing semantics locally (identity from timestamps,
ordering policies, attribution rules, fabricated lifecycle markers). Don't — a local
heuristic that papers over an upstream gap diverges from it silently and tends to
become the root cause of the next bug class (late-terminal misattribution is the
canonical example).

- Prefer the upstream mechanism that exists (an explicit lifecycle event, an explicit
  id) over inferring the same fact from side channels — and verify what the contract
  actually publishes before concluding it is silent.
- Semantic heuristics — anything that invents identity, ordering, or attribution the
  upstream contract does not carry — require an explicit user decision. When granted,
  label the heuristic where it lives and record the upstream gap it papers over in
  docs/governance.md — adjudications are logged in docs/decisions.md — and in the
  upstream issue when one exists.
- Mechanical safeguards (timeouts, size caps, idempotency guards against documented
  at-least-once delivery) are a different class: land them with a comment naming the
  bound and the blast radius. A safeguard that decides attribution or identity
  questions is NOT in this class — ask first.
- A heuristic that already exists must be labeled as such where it lives; never
  silently extend one to a new call site.
- Live capture is the primary requirement; offline transcript replay / historical import
  is secondary. Do not add branching or state-machine complexity to the live path to
  accommodate replay-only anomalies (such as out-of-order historical streams) that the
  live bus cannot produce — normalize or sort in the replay feeder instead.

## Spec baselines vs. CLI-ergonomic optimizations

Separate spec-mandated baselines from scenario-specific optimizations, and never let the
second pose as the first. Baselines are what a spec or upstream contract makes
non-negotiable — OTel semantic conventions, the bounded `ForceFlush`/`Shutdown` timeouts
(unload must never hang the host, whatever the backend does), deterministic IDs. They are
enforced unconditionally in the core mechanism, with a comment naming the bound and its
blast radius, and no configuration can switch them off.

Scenario-specific optimizations are the fast paths a particular deployment shape wants
— e.g. the CLI fast-fail shutdown (150 ms TCP pre-probe + skip the final flush after a
failed export) that exists because a local dev box with no collector running wants an
instant exit. Hard-wiring such an assumption into the transport contract would silently
break the shape it was not designed for (a strict remote/proxied OTel collector may
refuse bare TCP connects yet still accept OTLP POSTs, and its users want every
last-delivery attempt within the budget). Instead: keep them as explicit, composable
policy toggles on top of the intact baseline (`tracing.fastShutdown`, default on for the
ergonomic CLI experience, off for strict deployments). The rule of thumb: a new
optimization may never narrow what the baseline guarantees — only what it additionally
skips, and the skip must be visible in config and docs.

## Commits

Short imperative English subjects with a conventional prefix (`fix:` / `feat:` / `test:` /
`docs:` / `style:` / `refactor:` / `chore:`); a short body when the subject alone can't
carry the why. Commit with your own identity — prefer a GitHub noreply address
(`<id>+<username>@users.noreply.github.com`) over a personal email. This machine has no
global git identity configured, so pass `-c user.name=… -c user.email=…` or export
`GIT_AUTHOR_*` / `GIT_COMMITTER_*`.
