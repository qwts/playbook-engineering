# SOP: Issue lifecycle

How work is claimed, tracked, and closed against GitHub issues in any `qwts`
repo. Shared baseline under [ENG-0008](../decisions/ENG-0008-shared-sop-inheritance.md),
inherited by default and varied only by a documented delta. It pairs with the
[branch, PR, and review workflow](branch-pr-review.md): the issue is where work
starts and the PR is where it lands.

## Every change traces to an issue (mandatory — extend, don't drop)

- Work originates from a GitHub issue. If none exists for the change, open one
  first — the issue is the durable record of *why*, the PR of *how*.
- The PR closes its issue with a closing keyword, so the trace from problem to
  merged change is complete without manual bookkeeping.

## Before you start

- Check for active-claim signals so two people do not build the same thing: a
  `[WIP]` marker in the title, an assignee, an in-progress label, a linked PR, or
  a recent claim comment. If the work looks claimed, coordinate before starting.
- State the slice you intend to take on the issue, then proceed — coordination is
  visible, not narrated step by step.

## While the work is open

- Scope to the issue's stated deliverables and exit criteria. Adjacent but
  non-blocking concerns become their own issues; they do not expand the current
  one.
- Keep the issue current with the problem, the root cause once known, and the
  plan — enough that another contributor could pick it up.

## Feature issues (mandatory — extend, don't drop)

Feature work follows the [feature-lifecycle SOP](feature-lifecycle.md) (decision:
[ENG-0007](../decisions/ENG-0007-feature-lifecycle-convention.md)): it opens as a
spec — problem, requirements, design, proposed patterns — and closes as a record
of what was built. A repo may add sections to the shared feature form but may not
drop them.

## Implementation prompt and model routing (mandatory — extend, don't drop)

An issue intended for agent execution carries a prompt an agent can act on and a
routing recommendation ([ENG-0151](../decisions/ENG-0151-model-routing.md)).
Issues filed only to record a problem may omit it.

```markdown
**Tier:** T1 / T2 / T3 — why, especially where it disagrees with the diff size
**Recommended:** per vendor group, with reasoning level
**Routing verified:** <verified_at from the registry>
```

Two rules make it worth having:

- **Retrieve the routing; never recall it.** Read
  [`governance/agent-models.json`](../../governance/agent-models.json) — via
  `node tools/models/registry.mjs` — and cite its `verified_at`. Model names
  written from memory are stale the moment a vendor ships, and they fail
  confidently: a superseded name reads exactly like a current one. If the
  registry cannot be read, say so in the issue rather than substituting a
  remembered model.
- **State what proves the work, not that it was done.** The prompt ends with
  evidence that would fail if the change were wrong — a query whose output
  changes, a test that could not pass before. "The file exists" is the failure
  mode, not the check.

Tier follows the work, not the diff. A one-file change with cross-repo blast
radius or a failure mode that looks like success is T1.

## Closing

- Merging the linked PR closes the issue; do not leave the work as a lingering
  draft PR.
- If the change was only partially delivered, the remaining slice is captured as
  a new issue before the original closes, so nothing falls through the gap.

## Recorded deltas (see the inventory for the full list)

- **cartograph** additionally binds specification and traceability artifacts to
  the issue (user-story, acceptance-criterion, and test-map updates in the same
  PR); that is a cartograph traceability delta, not a shared requirement.

## Changelog

- 2026-07-22 — initial version; generalized the claim-and-close conventions from
  the photos and cartograph working agreements (ENG-0008).
- 2026-08-03 — added the mandatory implementation-prompt and model-routing
  section: agent-executed issues carry a tier, routing retrieved from
  `governance/agent-models.json` rather than recalled from memory, and evidence
  that would fail if the change were wrong ([ENG-0151](../decisions/ENG-0151-model-routing.md)).
