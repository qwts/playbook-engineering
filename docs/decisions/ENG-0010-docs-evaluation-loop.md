# ENG-0010: The docs evaluation loop — adopt with tight bounds, retire on silence

**Status:** Accepted
**Date:** 2026-07-22

## Context

[ENG-0009](ENG-0009-documentation-governance-gate.md) shipped the
deterministic documentation gate and explicitly deferred Phase 2 of
[issue #2](https://github.com/qwts/playbook-engineering/issues/2) — the
SkillOpt-shaped evaluation loop — to a separate decision backed by evidence.
The feared cost was the benchmark: the issue called it "the expensive part
and the real work" and warned it may not be worth maintaining.

The experiment has now been run. A 16-task benchmark (questions an agent
must answer from the docs alone, deterministic regex grading, an 11/5
train/validation split), a runner that stages any git revision of the docs
and asks a fresh headless agent each question, and a comparator that accepts
a revision only if the held-out validation score strictly improves. Measured
on two real revisions with a haiku-class executor
([results](../../tools/docs-eval/results/)):

- pre-Phase-1 docs: 50% overall (train 60%, validation 33%)
- with Phase 1 landed: 100% overall — comparator verdict ACCEPT, 8 tasks
  flipped to pass, none regressed
- cost per full run: minutes and well under a dollar; building the
  benchmark took hours, not weeks — the issue's cost fear was overstated
  at this scale, because the ENG series is small and its facts are crisp

## Decision

1. **Adopt the loop, bounded.** The benchmark, runner, and validation-gate
   comparator live in `tools/docs-eval/` and are run **on demand**: after a
   new ENG record, a doc restructure, or a repo adopting the governance
   gate. Never scheduled, never per-PR, never a merge gate — that remains
   docs-gov's job ([ENG-0009](ENG-0009-documentation-governance-gate.md)).
2. **The validation discipline is the non-negotiable part.** Doc edits that
   claim to help agents are measured train-vs-validation; a train-only gain
   is overfitting and is rejected. The tooling encodes this
   (`compare.mjs` exits nonzero) so the discipline survives personnel and
   model changes.
3. **Benchmark upkeep is part of doc work.** A PR that adds or changes
   normative guidance should extend the benchmark when the guidance is
   agent-load-bearing; grading stays deterministic regex, no LLM judge.
4. **Retire on silence.** If two consecutive meaningful doc changes produce
   runs with no actionable signal — no failing task leading to a doc fix,
   no rejected revision — the loop is retired to "run when curious" and this
   record is superseded. An eval that never changes a decision is cost, not
   evidence.

## Consequences

- The measured 50%→100% jump mostly reflects new docs answering questions
  about new tooling; the honest reading is that the *mechanism* is proven
  (revision scoring plus held-out acceptance), not that doc quality doubled.
  Stable-topic tasks passed at both revisions.
- Scores depend on the executor model; results are comparable only within a
  run pair using the same executor. The result files record the model.
- The grading regexes need occasional calibration (one was fixed during the
  baseline). This is cheap but nonzero, and it is the price of refusing an
  LLM judge — a judge would remove calibration work and add nondeterminism,
  which is the wrong trade for a ratchet.
- quorum inherits this loop for its own agent-facing docs per
  [ENG-0006](ENG-0006-agentic-primitives-governance.md)'s eval-gating
  direction; the golden-task sets ENG-0006 calls for can reuse this harness.

## References

- [Docs evaluation reference](../reference/docs-evaluation.md) — how to run, baseline evidence, cost
- [ENG-0009](ENG-0009-documentation-governance-gate.md) — the deterministic gate this complements, and the deferral this record resolves
- [microsoft/SkillOpt](https://github.com/microsoft/SkillOpt) — the validation-gated shape adopted here
