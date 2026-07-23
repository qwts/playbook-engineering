# ENG-0007: Feature lifecycle — open with problem, requirements, design, and proposed patterns; close with the solution as built

**Status:** Proposed
**Date:** 2026-07-22
**Issue:** predates issue-first (ENG-0013)

## Context

Feature issues across the org already lean the right way — photos, image-trail,
and cartograph carry user-story templates, and strong issues (e.g. photos#662)
open with Problem / Scope / Acceptance criteria. But the discipline is
half-adopted and unevenly enforced:

- Templates capture problem and scope; **none require a design section or name
  the patterns the proposed solution intends to use.**
- **Nothing anywhere requires a closeout.** Issues close on a merged PR, and
  the "what was actually built, and how it differed from the proposal"
  narrative evaporates into the diff. The reasoning trail this org treats as
  sacred for decisions (ENG series, photos ADRs) has no equivalent for
  features.
- bookmarkit has no templates at all; rigor there is per-author.

Two org-specific reasons this matters more than ordinary process hygiene:

1. **Agents are both the authors and the readers.** A feature issue is the
   context an agent implements from; a closeout is the context the next agent
   retrieves. Named patterns ("outbox", "capability-based undo", "sealed
   transport codec") are precisely the vocabulary that makes semantic search
   and reuse work — and, per ENG-0006, closed features with clean closeouts
   are the natural source of golden-task evals.
2. **Secure SDLC/STLC requires design before build.** Requirements stated up
   front become the acceptance criteria that tests trace to (cartograph's CI
   already runs a traceability check); a design stated up front is what a
   security review can actually review. Code-first-then-backfill defeats
   both.

## Decision

Every **feature** in every org repo follows one lifecycle, template-enforced:

**At open — the spec.** Four sections, in order:

1. **Problem** — the user or system pain, and why now. No solution language.
2. **Requirements** — numbered, testable statements; these become the
   acceptance criteria that tests and review trace back to.
3. **Design** — constraints, the architecture touchpoints (which
   processes/modules/contracts it lands in), and what is explicitly out of
   scope.
4. **Proposed solution, with patterns** — the intended approach, **naming
   the design patterns it applies** (existing repo patterns by their
   established names; new ones described and named so they can be cited
   later).

**At close — the closeout.** Before the issue closes, a closing comment (or
linked doc for large features) records:

<!-- markdownlint-disable-next-line MD029 -- section 5 deliberately continues the 1–4 numbering of the open-time spec -->
5. **Solution as built and patterns actually used** — including deltas from
   the proposal. Deviating from the proposed design is normal;
   *undocumented* deviation is the failure mode. If a new pattern emerged,
   name it here — this is where the org's pattern vocabulary grows.

**Proportionality.** This binds features (stories, epics, feature-labeled
issues). Bugs carry the lightweight analog already in use (problem /
root cause / fix); chores and typo-class changes are exempt. The test:
if the change warrants design review, it warrants the lifecycle.

**Enforcement and delivery.**

- A shared feature template implementing sections 1–4 lives in this
  repository and rolls out to every repo (issue-form YAML; the ENG-0003/0004
  delivery model — written once, consumed everywhere). Repo templates may
  extend it (photos' milestone/order fields); they may not drop sections.
- The closeout is checked at close time: the org-wide agent conventions doc
  (playbook#7) instructs agents to write section 5 before closing a feature
  they worked on, and review culture holds humans to the same bar.
- ENG-0006's golden-task eval sets draw from closed features whose closeouts
  exist — making the closeout the artifact that feeds the eval loop, not
  paperwork.

## Consequences

- Overhead is real on mid-size features and deliberate: the spec sections
  force design thinking before code, which is the Secure SDLC point. The
  proportionality rule is the pressure valve; if it gets abused to dodge the
  lifecycle, tighten the rule, not the exemptions.
- Closeout discipline is social until tooling exists (a close-time checklist
  or bot is possible future work; not built now). Expect imperfect
  compliance early; the agent-conventions instruction does most of the
  lifting since agents close most issues.
- Existing open issues are not retrofitted — the convention binds at open
  time from acceptance forward. Closed history stays as-is.
- Pattern naming only pays off if names stay consistent; the org-wide
  conventions doc should grow a short pattern glossary as closeouts
  accumulate, or the same pattern will accrete three names.
- bookmarkit gets issue templates for the first time as part of rollout.

## References

- [ENG-0003](ENG-0003-repo-is-documentation-source-of-truth.md) / [ENG-0004](ENG-0004-centralize-shared-cicd.md) — the write-once, consume-everywhere delivery model the shared template uses
- [ENG-0006](ENG-0006-agentic-primitives-governance.md) — agent conventions carry the closeout instruction; closeouts feed the golden-task eval sets
- [photos#662](https://github.com/qwts/photos/issues/662) — the de-facto house style this record completes with design/patterns/closeout
- cartograph's CI traceability check — the existing requirements→tests trace this record's numbered requirements feed
