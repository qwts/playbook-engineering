# ENG-0004: Centralize shared CI/CD in this repository

**Status:** Accepted
**Date:** 2026-07-19
**Issue:** predates issue-first (ENG-0013)

## Context

`qwts/photos` and `qwts/image-trail` are two instances of one engineering
template. Their CI is near-identical, not coincidentally similar:

- Same script taxonomy: `lint:package`, `lint:new-files`, `lint:cycles`,
  `lint:dead`, `lint:types`, `format:check`, `test:cov`, `coverage:summary`,
  `test:stories:ci`, `test:e2e`, a changeset gate, and an interop-contract check.
- Same `ci.yml` job skeleton: `changes` (path filter) → `ci` → an E2E lane
  behind a stable `E2E gate`, with the same draft-skip, `merge_group`, and
  per-SHA concurrency logic.
- Same process-tree guard (`scripts/run-guarded.mjs`) and the same
  ratcheting-floor philosophy.

photos' `ci.yml` is 411 lines, image-trail's is 319; the difference is
photos' extra lanes (i18n, licenses, a11y budget, gh-pages report), not a
different design. The two have already drifted — the same fix must currently be
written twice, and more repos are coming (cartograph, mobile ports).

## Decision

Shared CI/CD lives in this repository as **reusable workflows**
(`workflow_call`) and **composite actions** under `.github/workflows/` and
`.github/actions/`, consumed by each repo as:

```yaml
uses: qwts/playbook-software-engineering/.github/workflows/<name>.yml@v1
```

**Pinning: a moving `@v1` major tag**, consistent with how these repos already
pin third-party actions (`actions/checkout@v7`). Logic changes propagate to all
consumers with no per-repo edit; breaking changes go to `@v2`. The safety
condition is non-negotiable: **this repo runs its own CI that exercises the
reusable workflows before the `v1` tag is moved.** Without that gate, a bad push
breaks every consumer's CI at once — the central risk this pinning choice
accepts.

Rejected: pinning consumers to an exact SHA/tag with Renovate auto-bump. It is
safer, but reintroduces a per-repo bump PR — partially the maintenance this
decision exists to remove. The test-gated moving tag keeps the single-edit
benefit while containing the blast radius.

## Scope and phasing

Two phases, not a big-bang migration.

1. **Greenfield generic gates first.** Dependency scanning (`osv-scanner`) and
   secret scanning (`gitleaks`) — gates *neither* repo has yet. Build as
   reusable workflows, wire both repos in. No migration risk; proves the
   mechanism, the pinning strategy, and the playbook-side CI end to end.
2. **The shared skeleton, only after phase 1 validates.** Extract the common
   `changes` / `ci` / `E2E gate` structure into a reusable workflow that
   consumers parameterize (which lanes, which paths). Higher value, higher risk.

## Consequences

- A CI fix is written once and reaches every repo — the maintenance win.
- Coupling is now real: a defect in a shared workflow can break every consumer
  simultaneously. The playbook-side CI is the mitigation and is mandatory, not
  optional.
- This repo becomes CI-load-bearing for others. It must itself stay green and
  have its own dependencies clean — note the open Dependabot alerts on its
  markdownlint tooling; a CI-hub repo cannot ship with an unpatched toolchain.
- The check **scripts** (`scripts/*.mjs`) still live per-repo. Sharing those is a
  separate, larger step (a shared npm package) and is explicitly out of scope
  here; reusable workflows can call a repo's own scripts by convention.
- Repo-specific lanes (photos' i18n/a11y, image-trail's version-policy/artifacts)
  stay in each repo. Centralization covers the common substrate, not everything.

## Re-homing of prior follow-ups

- **Dependency and secret scanning** (noted absent in [ENG-0002](ENG-0002-static-analysis-direction.md)) → phase 1 of this decision.
- **CI reporting the last failure, not the first** (a masking bug found during #565: a failed test in an `&&`-chained lane surfaced as a coverage-floor error) → a property to fix in the phase-2 shared skeleton.
- **`max-lines-per-function` set to `warn`, never enforced** → *not* this decision. That is ESLint config, shared via a config package, a different mechanism. Tracked separately so it is not miscategorized as CI.

## Amendment — 2026-07-22: canonical consumption path after repo rename

The repository was renamed from `qwts/playbook-software-engineering` to
`qwts/playbook-engineering`
([#12](https://github.com/qwts/playbook-engineering/issues/12)), so the
canonical form of the consumption path in the decision is:

```yaml
uses: qwts/playbook-engineering/.github/workflows/<name>.yml@v1
```

GitHub's rename redirect covers git operations and web links but **not
Actions**: per
[GitHub's renaming documentation](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository),
calls to an action or workflow hosted by a renamed repository are not
redirected and fail with `repository not found`. Any consumer whose `uses:`
line still names the old repo must migrate it to the canonical path — this is
a required edit, not an optional cleanup. The pinning model and the CI-gated
`v1` tag are otherwise unaffected. The original snippet above is left as
written, per the rule that accepted records are amended, not rewritten.

## Amendment — 2026-07-31: lifecycle scheduling and trusted actors

Shared CI now includes the execution contract, not only reusable implementation
pieces. Every governed repository follows the
[CI execution policy](../reference/ci-execution-policy.md): draft PRs start no
Actions jobs and agents run lint/format/type/unit checks locally before marking
ready; an agent may manually run the complete suite for the final feature SHA;
ready PRs and ready updates reuse that evidence only for the exact SHA and
otherwise run every existing complete-suite gate; and an already-validated
merged SHA receives only a short
post-merge check. A merged SHA without complete-suite evidence falls back to
every gate. PR concurrency cancels obsolete runs, while one stable `CI` gate
prevents conditional expensive jobs from stranding branch protection.

Exact-commit validation uses rebase-only merges with the PR branch required to
be current. Merge queue is excluded because its `merge_group` workflow is
initiated by a GitHub-owned actor, which the trusted-actor policy refuses.

The repository-level GitHub Actions Policy is the primary execution boundary.
Only `qwts`, `chores-dumb[bot]`, `dependabot[bot]`, and the registered
`qwts-*-agent[bot]` Apps may initiate workflows. `github-actions[bot]`, other
third parties, and public-fork actors are refused before a runner starts.
Manual dispatch is limited to diagnostics, release recovery, workflow testing,
explicit reruns, and exact-SHA preflight validation before PR promotion. This
amendment changes when agreed validation runs; it does not remove docs-gov,
CodeQL, Storybook, E2E, smoke, or repository-specific security and compliance
gates.

Changesets and equivalent version-package PRs follow the same lifecycle. Their
generated version commit receives one complete-suite ready-PR validation;
version-cut automation does not dispatch a duplicate suite. Tag and release
jobs prove that their exact source commit has that successful evidence, then
run only release-specific version/provenance, artifact build, packaging,
signing, notarization, integrity, and packaged-mode smoke checks. Missing
evidence fails closed or requires an explicit complete-suite recovery run
before publication.

## Amendment — 2026-07-31: queue-validated `MERGE` commits

The rebase-only exclusion above is superseded. Governed default branches use
GitHub's required merge queue with merge method `MERGE`, `ALLGREEN` grouping,
one candidate build at a time, and one PR per merge. Ready-PR validation still
proves the reviewed head, but queue entry creates a new `merge_group` SHA from
current `main`; every agreed complete-suite gate runs on that exact candidate.
A successful queue run is the evidence reused for the short post-merge lane.
If the merged SHA lacks that evidence, `main` still fails safe by running the
complete suite.

The Actions Policy allows the `merge_group` event but does not add a new actor.
Both `github.actor` and `github.triggering_actor` remain restricted to `qwts`,
`chores-dumb[bot]`, `dependabot[bot]`, and registered active agent Apps. Public
forks remain ineligible: accepted changes move to a repository-owned branch
before validation or queue entry.

Rollout is staged so enabling the queue cannot strand a required check. First,
the repository's stable CI workflow gains `merge_group: checks_requested` and
the Actions Policy allows that event. Next, the ruleset requires the queue. A
pilot PR must prove the actual queue actor, the stable `CI` and retained check
contexts, the exact queue SHA, and the post-merge evidence handoff before the
same settings are applied to the rest of the governed fleet.

## Amendment — 2026-08-01: native queue pushes and preview actor policy

This amendment resolves
[#120](https://github.com/qwts/playbook-engineering/issues/120).

The native queue attributes its default-branch push to
`github-merge-queue[bot]`. The action authorizes it only when both actor fields
match on a `push` to `refs/heads/main`; every other event remains unauthorized.

GitHub's workflow-execution-protections preview cannot select the merge-queue
bot or express this event-scoped exception. Its actor restriction is disabled;
a repository role would authorize unrelated writers. Governed repositories
retain the immutable actor check, external-contributor approval with a
never-approve fork policy, read-only default token, action-source restrictions
and SHA pinning, required checks, and protected-branch review and queue rules.
Direct non-CI entrypoints run the action in authorization-only mode first.

Advanced CodeQL remains the lifecycle implementation rather than an actor-policy
workaround: its callable workflow follows draft, ready, queue, and post-merge
scheduling and preserves the required default-branch scan.

## Amendment — 2026-08-01: rollout portability and release semantics

The lifecycle is now owner-aware: organization-owned repositories use the
native queue, while user-owned repositories use strict checks, governed branch
updates, and exact-SHA fallback validation without changing their merge methods.
Required contexts bind to their actual publishers. Release lanes share semantic
Changesets output, and privileged writes share the Client ID/private-key
credential boundary. The existing PR concurrency contract remains unchanged.
The [CI policy](../reference/ci-execution-policy.md) and
[rollout checklist](../reference/governed-ci-rollout.md) define these controls.

## Amendment — 2026-08-02: source inputs and generated release projections

This amendment resolves
[#134](https://github.com/qwts/playbook-engineering/issues/134). In
`qwts/overlook#870`, commit `260fa140` applied one repository's Changesets
presence check to every complete suite. A generated Version packages PR then
failed after its reviewed Changesets had been intentionally consumed into
`package.json` and `CHANGELOG.md`. Retaining an empty Changeset only masked the
defect until automation regenerated the branch.

The decision: **release-input requirements belong to a repository's own
contract, not to the shared lifecycle, and a generated release projection is a
distinct lifecycle object from the source PR that fed it.** Governed CI
classifies a projection only from reviewed configuration and GitHub-owned
identity, and exempts it from one thing — retaining inputs it was designed to
consume. Every other gate, including exact-SHA CI, stable contexts, Advanced
CodeQL, reviews, version consistency, packaging, signing, provenance, and
release integrity, applies to it unchanged.

The operational contract is in the
[CI policy](../reference/ci-execution-policy.md); per-repository dispositions
are in the
[release-lifecycle fleet handoff](../reference/governed-ci-release-lifecycle-fleet.md).

## Amendment — 2026-08-18: harness release input

Resolves [#178](https://github.com/qwts/playbook-engineering/issues/178).
Harness syncs skip release input if reviewed identity, one source SHA, and
GitHub's full diff show only managed paths, including renames. Missing or mixed
evidence keeps source policy; other gates stay.

## References

- [ENG-0003](ENG-0003-repo-is-documentation-source-of-truth.md) established this repo as the cross-repo home for shared engineering assets; this extends that from documents to CI/CD.
