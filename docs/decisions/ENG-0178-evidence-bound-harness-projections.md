# ENG-0178: Governed harness projections are evidence-bound no-release inputs

**Status:** Accepted
**Date:** 2026-08-18
**Issue:** qwts/playbook-engineering#178

## Context

Governed harness synchronization changes shared tooling in consuming
repositories without changing their released package behavior. Changesets sees
those package-adjacent files change but cannot infer that they are a reviewed
projection, so a pure synchronization pull request fails after an unrelated
version pull request consumes the available changesets. Adding an empty
changeset makes the check green but falsely represents release intent and must
be repeated after later rebases.

The existing generated-release projection in
[ENG-0004](ENG-0004-centralize-shared-cicd.md) establishes that generated output
may consume its source release inputs. A harness projection needs a separate
classification because its no-release claim depends on proving both its bot
identity and the complete changed-path set.

## Decision

A governed harness synchronization is a `harness-projection` and may skip only
the repository release-input presence check when all of this evidence holds:

1. Reviewed lifecycle configuration identifies the expected base, head branch,
   head repository, and bot author.
2. Exactly one well-formed playbook source commit is recorded.
3. GitHub's complete paginated pull-request file list contains only paths in
   the governed harness inventory. Rename origins are governed paths too.
4. The evidence is unambiguous. Empty, malformed, incomplete, oversized, or
   mixed product-and-harness diffs retain normal source policy.

This classification does not waive tests, exact-SHA validation, CodeQL,
reviews, packaging integrity, provenance, or any other repository gate. Each
consumer explicitly adopts the new release-gate mode from a pinned shared
action revision and proves the behavior on its hosted synchronization pull
request.

## Why

Identity alone is insufficient because a bot branch can be widened manually.
A local checkout diff is also insufficient because shallow history, rename
interpretation, and event context vary across runners. GitHub's pull-request
file API is the authoritative hosted boundary, and pagination plus a bounded
file limit makes completeness an explicit part of the decision.

The alternative, empty changesets, records an event that did not occur and
couples an infrastructure projection to unrelated release timing. Treating all
bot-authored pull requests as no-release would fail open when product files are
mixed into the branch.

## Consequences

- Pure governed projections remain green when an unrelated version pull
  request consumes release inputs and the projection later rebases.
- A widened or unverifiable projection pays the normal release-metadata cost;
  false negatives are preferred to silently skipping required release intent.
- The classifier performs paginated GitHub reads and fails closed on API,
  schema, provenance, or size-bound errors.
- The source implementation alone is not fleet acceptance. Each Changesets
  consumer must pin the reviewed action revision, recognize
  `harness-projection`, and provide hosted evidence before issue #178 closes.

## References

- [Issue #178](https://github.com/qwts/playbook-engineering/issues/178) — problem, downstream incident, and implementation design
- [ENG-0004](ENG-0004-centralize-shared-cicd.md) — shared CI/CD ownership and generated release projections
- [CI execution policy](../reference/ci-execution-policy.md) — operational classifier contract
- [Release lifecycle fleet handoff](../reference/governed-ci-release-lifecycle-fleet.md) — per-repository adoption state
