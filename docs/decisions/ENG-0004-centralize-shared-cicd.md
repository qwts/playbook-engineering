# ENG-0004: Centralize shared CI/CD in this repository

**Status:** Accepted
**Date:** 2026-07-19

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

## References

- [ENG-0003](ENG-0003-repo-is-documentation-source-of-truth.md) established this repo as the cross-repo home for shared engineering assets; this extends that from documents to CI/CD.
