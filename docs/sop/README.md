# Shared SOPs

Standard operating procedures that describe **how work moves** across `qwts`
repositories — branch to PR to review to release. Each procedure is defined
once here and inherited by every repo under [ENG-0008](../decisions/ENG-0008-shared-sop-inheritance.md):
silence means baseline, and a repo varies a procedure only by recording an
explicit delta in its own tree, adjacent to the link, with a one-line why.

## What is an SOP (and what is not)

An SOP says *how work moves*: the branch → PR → review → release mechanics that
should look the same regardless of which repo you are in. Product and
architecture choices are **not** SOPs — they stay in ENG records or a repo's own
ADR series. The routing test from [ENG-0008](../decisions/ENG-0008-shared-sop-inheritance.md):
if two or more repos are expected to follow it, it is shared; if exactly one repo
would change, it stays in that repo. When in doubt, it is a decision, not an SOP.

## The mandatory-section boundary

Sections marked **(mandatory — extend, don't drop)** are the extend-don't-drop
floor generalized from [ENG-0007](../decisions/ENG-0007-feature-lifecycle-convention.md):
a repo may add to them but may not remove them in a delta. Everything else is a
default a repo may override with a documented delta. An undocumented deviation is
a bug, exactly like a shared fact stated twice in two agent files.

## Index

| SOP | Scope | Covers |
| --- | --- | --- |
| [Repository baseline files](repo-baseline-files.md) | Every repo | The files and repo settings each repo must carry |
| [Branch, PR, and review workflow](branch-pr-review.md) | Every repo | How a change goes from branch to merged, and the review bar |
| [Issue lifecycle](issue-lifecycle.md) | Every repo | How work is claimed, tracked, and closed against issues |
| [Feature lifecycle](feature-lifecycle.md) | Every repo | The shared feature issue form and the closeout every feature records (ENG-0007) |
| [Release and versioning](release-and-versioning.md) | Repos that cut releases | Changelog, version consistency, and dependency bumps |
| [Security reporting and response](security-response.md) | Every repo | How vulnerabilities are reported, and the settings that back it |

## Inheritance in practice

- A repo with no local statement of a procedure follows the shared SOP above.
- Repo files (AGENTS.md, CONTRIBUTING.md, docs) **link** to these SOPs; they
  never copy them. A copy is a fork, and a fork drifts silently.
- A repo that needs to differ records **only the difference** next to its link,
  citing the SOP section it modifies so a baseline edit makes stale deltas
  findable.
- Promotion and demotion are routine: a repo-local procedure a second repo needs
  moves up here; an SOP only one repo still follows moves back down. ENG-0008 is
  the standing authorization — no new decision record is required.

## Migration status

The one-time inventory of what each repo does today, its shared-vs-local
classification, and the deltas each repo carries forward lives in
[the SOP inventory](inventory.md).

## Changelog

- 2026-07-31 — make lifecycle-aware CI scheduling part of the shared branch/PR baseline.
- 2026-07-22 — initial index; seeded the branch/PR/review, issue-lifecycle,
  release-and-versioning, and security-response baselines alongside the existing
  repository-baseline-files SOP (ENG-0008 Phase 2).
