# ENG-0313: Install lanes carry fan-out backpressure, and evidence lanes never queue behind them

**Status:** Proposed
**Date:** 2026-08-27
**Issue:** qwts/playbook-engineering#313

## Context

One `main` push brings every open pull request up to date. Each update mints a
fresh head SHA, so exact-SHA evidence reuse cannot match and per-PR
cancellation never fires — each PR gets exactly one new run. A single push
therefore starts O(open PRs) complete suites at once, and their identical
dependency installs race the same origins. Cartograph measured seven
simultaneous suites from one action-pin bump, and that stampede produced the
six-hour stalled `apt-get update`.

[ENG-0267](ENG-0267-bounded-ci-runtime.md) caps what one stalled install costs.
[ENG-0269](ENG-0269-trusted-dependency-reuse.md) removes most repeat downloads.
Neither limits how many install lanes reach an origin simultaneously.

The two structural fixes are unavailable to these repositories: GitHub restricts
merge queues to organization-owned repositories, and custom runner images
require organization or enterprise larger runners at unapproved cost. Workflow
`concurrency` is the control this user account already has.

## Decision

A job that reaches a package origin — one that runs
`bounded-dependency-install` — declares job-level `concurrency`:

1. `pull_request`-triggered lanes share one repository-wide group per lane, so
   at most one identical install sequence is in flight. This is
   merge-one-and-wait, enforced by CI rather than by convention.
2. `cancel-in-progress` is literally `false`. Backpressure queues a lane; it
   never kills a running install.
3. Runs that carry exact-SHA evidence — `push`, `merge_group`, and
   `workflow_dispatch` — take a unique per-run group. A post-merge, queue, or
   preflight lane is never superseded by pull-request traffic, and no commit
   loses its evidence to a scheduling decision.

The shared runtime checker rejects an install-bearing job that omits the group,
that cancels in progress, or whose group carries no per-run escape. Expressions
where the checker needs a literal fail closed. Group names are repository
deltas; the shape is fleet policy.

## Consequences

- A `main` push queues its fan-out instead of racing it. A pending job holds no
  runner, so the cost of waiting is zero VMs.
- GitHub keeps one pending run per group, so a third arrival cancels the second.
  A superseded PR lane goes red and re-runs on its next updater head. That is
  the accepted cost: a cancelled lane is never read as validated.
- Serialization is per lane, not per repository. Cheap gates keep running while
  an install waits.
- Stacked merges still start one evidence lane per commit by design. Their cost
  is bounded by ENG-0267 and reduced by the ENG-0269 cache, not by this record.
- The checker verifies that a per-run escape exists, not that its condition is
  correct; the expression is still reviewed.

## Alternatives

- **Native merge queue:** the right answer, and unavailable — organization-owned
  repositories only. Revisit on any organization migration.
- **`cancel-in-progress: true` on install lanes:** rejected because it kills a
  running install and can cancel an evidence lane, trading a cost problem for an
  evidence gap.
- **One repository-wide group for every event:** rejected because it lets
  pull-request traffic supersede a pending post-merge or preflight lane.
- **Throttling by retry or sleep inside the job:** rejected because a waiting
  runner is a paid stalled VM, which is the problem being solved.
