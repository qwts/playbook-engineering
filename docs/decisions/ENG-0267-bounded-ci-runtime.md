# ENG-0267: Bound CI jobs and external setup tasks centrally

**Status:** Proposed
**Date:** 2026-08-20
**Issue:** qwts/playbook-engineering#267

## Context

Governed workflows inherit one lifecycle policy but still implement runtime
limits repository by repository. During an Ubuntu mirror outage, Cartograph
jobs remained inside dependency-install steps until GitHub's six-hour limit.
A job timeout would reduce that cost but would still misidentify the failed
boundary and leave every repository to invent process cleanup and retries.

## Decision

The shared CI contract has two enforced limits:

1. Every runner job declares a literal whole-job `timeout-minutes`. Reusable
   jobs inherit the limit from each runner job in the called workflow.
2. External dependency and tool setup runs through the shared bounded-command
   action. It launches an explicit executable without a shell, applies a
   per-attempt deadline and finite retry count, terminates the process tree,
   and emits a stable failure classification naming the task.

The playbook runtime checker rejects an unbounded runner job or a known raw
dependency installer. A necessary exception names its owner, maximum duration,
review trigger, and reason in the workflow. Release and packaging work may use
larger limits, never an absent limit.

Consumers pin the reviewed action and checker by immutable commit SHA. Local
workflow budgets remain repository deltas, but the existence and shape of the
boundary are fleet policy.

## Consequences

- A stalled dependency operation fails where it stalls instead of consuming
  the rest of a job's budget.
- Process-tree cleanup and retry diagnostics are implemented and tested once.
- Workflows become slightly more verbose and timeout budgets require measured
  maintenance as legitimate runtimes change.
- A bad shared runner has fleet blast radius; immutable pins, playbook CI, and
  synthetic hang tests protect its rollout.
- Timeouts limit failure cost but do not prevent repeated downloads; dependency
  reuse and runner-image selection remain [#269](https://github.com/qwts/playbook-engineering/issues/269).

## Alternatives

- **Job timeouts only:** rejected because they identify the lane, not the
  stalled task, and can still waste tens of minutes.
- **Repository-local shell loops:** rejected because process cleanup and error
  classification drift across the fleet.
- **Unlimited release jobs:** rejected because an operational exception still
  needs a finite incident boundary.
