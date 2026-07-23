# SOP inventory and migration map

The one-time survey behind [ENG-0008](../decisions/ENG-0008-shared-sop-inheritance.md)
Phase 1: what procedures each `qwts` repo states today, whether each is a shared
baseline or a repo-local concern, and the delta each repo carries once it
re-points at the [shared SOPs](README.md). This is a migration record, not a
procedure — the SOPs themselves are the authority.

The authoritative list of governed repos is the manifest behind
[governed-repos.md](../reference/governed-repos.md) ([ENG-0011](../decisions/ENG-0011-governed-scope-manifest.md));
the repo names below are a point-in-time snapshot of this migration survey, not
the source of truth.

## Where procedures live today

| Repo | Source of its procedures | Notes |
| --- | --- | --- |
| photos | its canonical contributing guide under `docs/` (repo markdown files are stubs), plus its own ADR series | The most mature working agreement; the shared baselines are extracted from it |
| cartograph | `AGENTS.md` | Issue-first, branch-prefix, and traceability rules stated inline |
| image-trail | `AGENTS.md` | Trunk-based workflow plus coverage and acceptance-map gates stated inline |
| bookmarkit | none | Consumer — inherits every baseline, proving the inheritance model |
| quorum | none | Consumer — created 2026-07-22, inherits from day one |

## Classification: shared vs local

**Promoted to shared SOPs** (the common denominator across photos, cartograph,
and image-trail):

- Trunk-based branching, one objective per PR, `Closes #N` issue linking,
  rebase-before-review, ready-for-review as done, and explicit review-thread
  resolution → [branch, PR, and review workflow](branch-pr-review.md).
- Issue-first work, claim-signal checks, scope-to-exit-criteria, and the ENG-0007
  feature lifecycle → [issue lifecycle](issue-lifecycle.md).
- Changelog-in-the-same-PR, version consistency, and Dependabot-only dependency
  bumps → [release and versioning](release-and-versioning.md).
- Private-advisory reporting and the ENG-0005 security settings → [security
  reporting and response](security-response.md).

**Kept repo-local** (product and architecture, not *how work moves* — they stay
in each repo's ADRs or ENG records):

- photos' library-format, encryption, sync-journal, and recovery ADRs, and its
  testing strategy and acceptance-test suites.
- cartograph's traceability model (user-story ↔ acceptance-criterion ↔ ADR ↔
  test binding) as a *product* discipline, beyond the shared issue trace.

## Deltas each repo carries forward

Recorded here for the migration; each becomes a one-line delta next to that
repo's link when it re-points (Phase 3), citing the SOP section it modifies.

| Repo | Delta | Section it modifies |
| --- | --- | --- |
| cartograph | Branch prefixes `feat/ fix/ chore/ docs/`; issue must exist before the branch | Branch, PR, and review → Branching |
| cartograph | Rust gate: fmt, clippy `-D warnings`, test; frontend lint/typecheck/test/build; version-consistency check | Release and versioning |
| cartograph | Spec/traceability artifacts updated in the same PR | Issue lifecycle |
| image-trail | Coverage floor 71% lines / 80% branches, enforced by the aggregate CI command | Release and versioning |
| image-trail | Acceptance coverage-map update (or a `no-acceptance-impact` label) for UI/content changes | Branch, PR, and review → The merge bar |
| photos | Version-consistency gate in CI | Release and versioning |
| bookmarkit | none — pure consumer | — |
| quorum | none — pure consumer | — |

## Phase 3: re-pointing

Replacing each repo's restated procedures with a link plus its delta happens in
that repo, folded into its open ENG-0006 alignment issue (dedupe and re-pointing
are one pass). That work is out of scope for this playbook PR, which stands up
the baselines; the deltas above are the input each repo's re-pointing PR
consumes.

## Changelog

- 2026-07-22 — initial inventory from the photos, cartograph, and image-trail
  working agreements and the photos wiki/docs survey (ENG-0008 Phase 1).
