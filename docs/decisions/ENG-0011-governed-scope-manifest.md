# ENG-0011: Governed scope is a manifest — one source of truth, add/remove by editing it

**Status:** Proposed
**Date:** 2026-07-23
**Issue:** qwts/playbook-engineering#20

## Context

The playbook governs a set of repositories, but nothing says *which* set. The
model is settled — [ENG-0008](ENG-0008-shared-sop-inheritance.md) makes every
`qwts` repo inherit the shared baselines by default — yet the scope itself lives
only as prose, restated across at least four documents that already disagree:

- [the SOP inventory](../sop/inventory.md) lists photos, cartograph, image-trail, bookmarkit, quorum;
- [the GitHub account reference](../reference/github-account.md) adds private repos;
- [ENG-0006](ENG-0006-agentic-primitives-governance.md) enumerates a fifth, overlapping set;
- [the conformance checklist](../reference/agentic-primitives-conformance-checklist.md) hardcodes per-repo alignment issue numbers.

This is the same failure ENG-0004 and ENG-0008 named: a fact restated in N places
is N forks that drift. There is also no defined way to onboard a new repo or to
offboard a retired one — the account has no organization to act as an implicit
membership list ([ENG-0001](ENG-0001-cross-repo-decision-home.md)), so "what do we
govern" has no answerable home.

## Decision

1. **A manifest is the single source of truth.** `governance/repos.json`
   enumerates the governed repositories with per-repo metadata: `visibility`,
   `status` (`active` / `onboarding` / `retired`), `sharedCi`, and the repo's
   one-line `delta` from the baseline. JSON, not YAML, to stay zero-dependency —
   the same reason ENG-0009's tooling ships none.
2. **The human table is generated, not authored.** `tools/repos/repos.mjs`
   validates the manifest and renders the table into
   [governed-repos.md](../reference/governed-repos.md) between fixed markers; CI
   fails on an invalid manifest or a table that drifts from it. This follows
   ENG-0004's delivery shape: a zero-dependency CLI, gated in this repo's CI.
3. **Add and remove are manifest edits.** Onboard by adding a row
   (`status: onboarding`, flipped to `active` on conformance); offboard by
   flipping `status` to `retired` — rows are never deleted, matching the ENG
   supersede-don't-erase rule, so the record of what was once governed survives.
4. **The manifest is a registry, not an allowlist.** It records the governed
   universe; it does not gate governance. ENG-0008's inherit-by-default still
   holds: a new `qwts` repo is governed the moment it exists, and the manifest's
   job is to make that set *knowable in one place*, not to admit repos into it.
5. **The scattered prose re-points here.** The non-decision docs that enumerated
   repos now link to the manifest instead of restating it; the ENG records that
   mention repos are left as written (they are superseded, not rewritten).

## Consequences

- The manifest can drift from GitHub's actual repository set — nothing syncs it
  from the API. Accepted for now: the truth this repo needs is "what do we intend
  to govern," which is a human decision, not an API read. An API reconciliation
  check is possible later but deliberately out of scope.
- JSON loses the inline comments a YAML manifest could carry; the per-repo `note`
  field and this record absorb that context instead. The cost buys a stdlib
  parser and a check that runs from a bare checkout.
- One more generated artifact to keep in sync — the classic generated-file trap.
  Mitigated exactly as docs-gov mitigates its own: the drift check is in CI, so an
  un-regenerated edit fails the build rather than merging stale.
- Retired rows accumulate. Accepted; the history is the point, and `status`
  filtering keeps the active set legible.
- Because the manifest is a registry and not a gate, someone can still create a
  repo and forget to record it — it stays governed by inheritance but invisible
  here. The manifest is a completeness aim enforced by convention and review, not
  a mechanism that governs on its own.

## References

- qwts/playbook-engineering#20 — the originating issue (opened retroactively, pre-ENG-0013)
- [ENG-0008](ENG-0008-shared-sop-inheritance.md) — inherit-by-default, the model this registry records against
- [ENG-0004](ENG-0004-centralize-shared-cicd.md), [ENG-0009](ENG-0009-documentation-governance-gate.md) — the zero-dependency, CI-gated tooling shape reused here
- [governed-repos.md](../reference/governed-repos.md) — the generated view and the add/remove process
