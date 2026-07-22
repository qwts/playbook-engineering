# SOP: Feature lifecycle

**Scope:** every `qwts` repository. **Model:** [ENG-0008](../decisions/ENG-0008-shared-sop-inheritance.md) —
inherit by default, vary by explicit delta. **Decision:** [ENG-0007](../decisions/ENG-0007-feature-lifecycle-convention.md).

A feature opens as a spec and closes as a record. The open-time issue form captures
four sections before any code exists; the closeout captures what was actually built.
This SOP is the operational home of both — the shared form every repo carries and the
closeout an agent posts before it closes a feature.

## What this binds

Features: stories, epics, and feature-labelled issues. Bugs use their own lightweight
problem / root-cause / fix form; chores and typo-class changes are exempt. The test —
if a change warrants design review, it takes this lifecycle.

## At open — the four-section spec

The shared issue form lives at
[`.github/ISSUE_TEMPLATE/feature.yml`](../../.github/ISSUE_TEMPLATE/feature.yml) in this
repository. Every repo carries a copy or an extension of it: a repo may add fields
(milestone, ordering, repo-specific labels) but may not drop a section. Its four
required sections, in order:

1. **Problem** — the pain, and why now, stated with no solution language yet.
2. **Requirements** — numbered and testable; each becomes an acceptance criterion that
   tests and review trace to.
3. **Design** — the constraints, the architecture touchpoints the work lands in
   (processes, modules, contracts), and what is explicitly out of scope.
4. **Proposed solution, with patterns** — the intended approach, naming the design
   patterns it applies. Reach for an existing repo pattern by its established name
   first; name and describe a genuinely new one so later work can cite it.

## At close — the closeout

The closeout is **section 5** of the spec — it continues the 1–4 numbering above the
line at open. Before a feature issue closes, its closing comment (or a linked document,
for a large feature) records the solution as built and the patterns actually used,
including any delta from the proposal. Deviating from the proposed design is expected;
leaving the deviation unrecorded is the failure this catches. Name any pattern that
emerged so the org's shared vocabulary grows rather than fragments.

**Agents:** post this closeout before you close any feature you worked on. Review
culture holds humans to the same bar. Closed features whose closeouts exist are what
[ENG-0006](../decisions/ENG-0006-agentic-primitives-governance.md)'s golden-task evals
draw from — the closeout is the artifact those evals need, not paperwork.

### Closeout comment template

Copy this into the closing comment and fill it in:

```markdown
## 5. Solution as built and patterns actually used

**Built:** what actually shipped, and where (the PRs / commits that closed this).

**Patterns used:** the section-4 patterns that survived, by name.

**Deltas from the proposal:** what changed against the Design / Proposed-solution
sections, and why. Write "none" only when the build matched the spec.

**New patterns named:** any pattern that emerged, with a one-line definition — or "none".
```

## Rollout

Source of truth is here; repos consume it under the [ENG-0003](../decisions/ENG-0003-repo-is-documentation-source-of-truth.md) /
[ENG-0004](../decisions/ENG-0004-centralize-shared-cicd.md) write-once model.

- **photos, image-trail, cartograph** — extend their existing story / task templates
  with the Design and Proposed-solution sections they currently lack; keep their extra
  fields.
- **bookmarkit** — adopt the shared form as its first issue template.
- **quorum** — born with the form when the repo is scaffolded.
- The closeout instruction is carried by the org-wide agent conventions doc (playbook#7),
  which links to this SOP rather than restating it.

## Changelog

- 2026-07-22 — initial version; implements [ENG-0007](../decisions/ENG-0007-feature-lifecycle-convention.md) (playbook#9).
