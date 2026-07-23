# ENG-0008: Shared SOPs — defined once here, inherited by default, varied only by explicit delta

**Status:** Accepted
**Date:** 2026-07-22
**Issue:** predates issue-first (ENG-0013)

## Context

The org keeps deciding the same meta-question one artifact class at a time,
and keeps reaching the same answer:

- [ENG-0003](ENG-0003-repo-is-documentation-source-of-truth.md): shared
  documentation lives centrally; repos reference it.
- [ENG-0004](ENG-0004-centralize-shared-cicd.md): shared CI is written once
  and consumed at `@v1`; repo-specific lanes stay per-repo.
- [ENG-0006](ENG-0006-agentic-primitives-governance.md): org-wide agent
  conventions live here; per-repo AGENTS.md files link rather than restate.
- [ENG-0007](ENG-0007-feature-lifecycle-convention.md): the shared feature
  template rolls out everywhere; repos "may extend, may not drop sections."

Four records, one unnamed pattern: **a shared baseline defined centrally,
inherited by default, with bounded per-repo variation.** Meanwhile the
procedures themselves — release process, PR workflow, review expectations,
versioning/changesets, incident handling — exist unevenly: photos maintains
real SOPs (originally in its wiki, per its ADR series), cartograph and
image-trail restate overlapping working agreements in their AGENTS.md files,
bookmarkit has none. Every restatement is a fork that drifts silently — the
same failure mode ENG-0004 measured in CI (411- vs 319-line near-identical
`ci.yml`s) and PR #8's review caught in this very repo's self-knowledge.

## Decision

State the pattern once and apply it to standard operating procedures as a
class, not per-instance:

1. **Shared SOPs are defined in this repository** (`docs/sop/`), one
   procedure per document. An SOP belongs here under the existing ENG test,
   applied to procedures: **if two or more repos are expected to follow it,
   it is shared; if exactly one repo would change, it stays in that repo.**
2. **Repos inherit by default.** A repo with no local statement of a
   procedure follows the shared SOP; silence means baseline, not exemption.
   Repo files (AGENTS.md, CONTRIBUTING.md, docs) link to the shared SOP —
   they never copy it. A copy is a fork; a fork is drift.
3. **Variation is an explicit, documented delta.** A repo may extend or
   override a shared SOP by recording *only the difference* in its own repo,
   adjacent to the link, with a one-line why. Sections the shared SOP marks
   **mandatory** can be extended but not dropped (the ENG-0007 rule,
   generalized). An undocumented deviation is a bug, exactly like a shared
   fact stated in two agent files (ENG-0006).
4. **Promotion and demotion are cheap and expected.** A repo-local procedure
   that a second repo starts needing moves up (PR here, repos re-point). A
   shared SOP that only one repo still follows moves down. The playbook's
   ENG index treats SOP moves as routine maintenance, not decisions —
   this record is the standing authorization.
5. **Baselines are versioned by changelog, not frozen.** Each SOP carries a
   dated change log; a substantive change notifies consumers the ENG-0004
   way (it rides the same review-then-propagate discipline as a `@v1` move).
   Per-repo deltas cite the section they modify so a baseline edit makes
   stale deltas findable.

## Consequences

- Migration work: inventory the procedures that exist today (photos' SOPs,
  the working agreements restated across AGENTS.md files), promote the
  genuinely shared ones into `docs/sop/`, and replace restatements with
  link + delta. This folds naturally into the ENG-0006 alignment issues
  already open per repo — dedupe and re-pointing are the same pass.
- This repo becomes procedure-load-bearing the way ENG-0004 made it
  CI-load-bearing: an SOP edit here changes expected behavior in every repo.
  The mitigation is the same — review here is the gate, and the changelog
  makes changes visible.
- Delta rot is the new failure mode: a baseline edit can silently invalidate
  a repo's recorded delta. Accepted; deltas citing baseline sections keep it
  greppable, and the periodic dedupe lane (ENG-0006's jscpd check) catches
  re-forking, which is the worse disease.
- Judgment calls remain about what is "procedure" versus "product decision."
  The line: SOPs say *how work moves* (branch → PR → review → release);
  product and architecture decisions stay in ENG records and repo ADRs. When
  in doubt, it is a decision, not an SOP.
- bookmarkit and quorum get their process for free — the point of the whole
  exercise. The cost lands on photos, whose mature local SOPs must be split
  into "shared baseline" and "photos delta."

## References

- [ENG-0003](ENG-0003-repo-is-documentation-source-of-truth.md), [ENG-0004](ENG-0004-centralize-shared-cicd.md), [ENG-0006](ENG-0006-agentic-primitives-governance.md), [ENG-0007](ENG-0007-feature-lifecycle-convention.md) — the four instances this record generalizes
- [`qwts/photos` wiki/docs](https://github.com/qwts/photos/wiki) — the existing SOP corpus the migration inventory starts from
