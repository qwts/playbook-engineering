# Documentation evaluation (docs-eval)

The Phase 2 companion to [documentation governance](documentation-governance.md): where docs-gov deterministically checks that docs are well-formed, docs-eval measures whether they *work* — can an agent, given only the docs, answer the questions the org needs answered? It is SkillOpt-shaped, costs model calls, and runs on demand; it is never a merge gate. Decision record: [ENG-0010](../decisions/ENG-0010-docs-evaluation-loop.md).

## How it works

1. **Benchmark** — [`tools/docs-eval/benchmark.json`](../../tools/docs-eval/benchmark.json) holds tasks an agent should complete from the docs alone ("which gate enforces X", "what is the routing test for Y"). Each task carries deterministic grading regexes (`mustMatch`, all case-insensitive) — no LLM judge, so a grade never flakes. Tasks are split **train / validation**: train tasks may inform doc edits; validation tasks are held out.
2. **Run** — [`tools/docs-eval/run.mjs`](../../tools/docs-eval/run.mjs) stages the doc set from a git ref (or the working tree) into a temp dir, asks a fresh headless agent each question with that dir as its entire world (so code cannot answer for the docs), and grades. `--answers file.json` grades pre-collected answers instead, decoupling the executor from the grader.
3. **Gate** — [`tools/docs-eval/compare.mjs`](../../tools/docs-eval/compare.mjs) compares two result files and ACCEPTs a doc revision only if the held-out validation score strictly improves. Train-split gains with flat validation are rejected as benchmark overfitting; if validation sits at its ceiling, the fix is extending the validation set, not loosening the gate. This is the SkillOpt validation discipline, and the same ratchet logic as the coverage floors.

## Running

```bash
npm run docs:eval                # working tree, claude CLI executor
node tools/docs-eval/run.mjs --ref main --out baseline.json
node tools/docs-eval/compare.mjs baseline.json candidate.json
```

The default executor shells out to `claude -p` per task (any authenticated Claude Code install). Results land in `tools/docs-eval/results/` — one JSON per run, committed, so scores are comparable across revisions and over time.

## Baseline evidence (2026-07-22)

Sixteen tasks, haiku-class executor, run against two revisions of this repo's docs:

| Revision | Train | Validation | Overall |
| --- | --- | --- | --- |
| pre-Phase-1 (`1c25521`) | 60% | 33% | 50% |
| Phase 1 landed (PR #13) | 100% | 100% | 100% |

`compare.mjs` verdict: **ACCEPT** — 8 tasks flipped to pass, none regressed. Honest caveat: most flipped tasks ask about docs-gov itself, which did not exist at the old revision, so this run demonstrates the *measurement mechanism* (revision-vs-revision scoring plus the held-out gate) more than it proves doc-quality gains on stable topics. The stable-topic tasks (ENG-0001 through ENG-0008 questions) passed at both revisions. One grading regex was calibrated during the baseline (hyphenated `false-positive`); expect a small calibration tail whenever tasks are added.

## Cost and cadence

A full run is 16 fresh agent sessions over a ~50k-token doc set — minutes of wall clock and well under a dollar at haiku-class pricing. Cadence per ENG-0010: after a doc change big enough to warrant it (a new ENG record, a restructure, an adoption), not scheduled and not per-PR. When docs change, extend the benchmark first, then measure the change.
