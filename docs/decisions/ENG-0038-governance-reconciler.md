# ENG-0038: Governance reconciler — one operation converges any repo to the manifest

**Status:** Proposed
**Date:** 2026-07-23
**Issue:** qwts/playbook-engineering#38

## Context

Adding a repo to governance was manual: create it, install the four agent
Apps, copy baseline files, configure rulesets, add the manifest entry, hope
nothing drifts. Migrating an old repo had no defined process. A template repo
cannot fix this: templates only seed, cannot express settings, cannot
retroactively fix drift ([ENG-0006](ENG-0006-agentic-primitives-governance.md)
no-grandfathering), and would be a third source of truth. Phase 1
(`tools/repos/drift.mjs`, read-only) detects the gaps; this record governs
the phase that closes them.

## Decision

1. **One operation.** `tools/repos/reconcile.mjs` converges a repo — new,
   existing, or migrating — toward `governance/repos.json`. An empty repo is
   just a migration with zero conflicts. Dry-run by default; `--apply`
   executes.
2. **Three lanes, split by GitHub's permission model** (structural, not
   stylistic — `qwts` is a user account):
   - **settings** — rulesets and repo settings need admin, which no App on a
     user account has: applied with the human's ambient token. Review count
     is raised to ≥ 1 ([ENG-0045](ENG-0045-agent-environments-are-bot-territory.md)
     backstop), never lowered; a repo with no ruleset gets the standard one,
     minus required status checks (per-repo).
   - **seeds** — missing baseline files are proposed as a **bot-authored PR**
     to the target repo, never a direct push: the seeded content itself goes
     through review. Seeds: `AGENTS.md`, `CONTRIBUTING.md`, `CODEOWNERS`
     (templates under `governance/baseline/`), and the shared feature form
     (this repo's own `.github/ISSUE_TEMPLATE/feature.yml` — one source of
     truth, no copy).
   - **human** — printed, never attempted: repo creation and per-repo App
     installation are user-to-server-only; `README.md` and `LICENSE` are
     deliberately per-repo (repo-baseline-files SOP) and generating them
     would fake conformance.
3. **Converge adds, never clobbers.** Only files the drift detector found
   *missing* are seeded. Existing divergent content is a delta per
   [ENG-0008](ENG-0008-shared-sop-inheritance.md): recorded in the manifest's
   `delta` field or normalized in review — never overwritten by tooling.
4. **The manifest is the migration contract.** `status: onboarding` declares
   a repo mid-convergence (drift reported, CI not failed); flipping to
   `active` is the human's act of accepting conformance. `delta` is the
   recorded-divergence field.
5. **Runs from this checkout only.** Templates and canonical files resolve
   against the playbook working tree — the runtime source of truth
   ([ENG-0045](ENG-0045-agent-environments-are-bot-territory.md) decision 5);
   zero dependencies ([ENG-0004](ENG-0004-centralize-shared-cicd.md)).

## Consequences

- Onboarding or migrating a repo is: create it, install the Apps, add the
  manifest row, run `reconcile --apply`, review the seed PR, flip to
  `active`. The same command re-run is a no-op on a conformant repo.
- The human lane means apply can report "blocked on you" instead of
  mysteriously 403ing — bootstrap steps are modeled, not discovered.
- Seed templates are deliberately minimal pointers into this playbook;
  repos grow real content in review, not from generators.
