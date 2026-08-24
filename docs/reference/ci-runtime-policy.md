# CI runtime budgets

Operational contract for the two runtime boundaries required by
[ENG-0267](../decisions/ENG-0267-bounded-ci-runtime.md). The owning lifecycle
and exact-SHA evidence rules remain in the
[CI execution policy](ci-execution-policy.md).

## Whole-job backstop

Every job that declares `runs-on` also declares a literal, reviewed
`timeout-minutes`. Reusable-workflow calls have no caller-side timeout field;
each runner job in the called workflow owns its finite limit.

Policy, evidence, and stable-gate jobs normally use short limits. Test, build,
CodeQL, release, and packaging jobs use limits measured from their cold runtime
with explicit headroom. Repository-specific numeric budgets are valid deltas.
No lane is unlimited merely because its runtime varies.

## External setup deadline

The job limit is the final backstop, not the diagnostic boundary. External
dependency and tool setup uses the shared `bounded-command` action from
`playbook-engineering`, pinned by immutable commit SHA in consumers. It:

- launches an explicit executable and JSON arguments without a shell;
- applies a per-attempt deadline, finite attempt count, and finite retry delay;
- captures and terminates the process tree, including POSIX descendants that
  detach into another process group or session; and
- reports the task, attempt, elapsed time, deadline, and stable classification.

A dependency stall therefore fails at the named setup step in minutes instead
of consuming the whole job budget. Callers pass no secret through an argument;
the action does not print arguments or the environment.

```yaml
- name: Install locked dependencies
  uses: qwts/playbook-engineering/.github/actions/bounded-command@<reviewed-sha>
  with:
    task: Install locked dependencies
    executable: npm
    arguments-json: '["ci"]'
    timeout-seconds: '300'
    attempts: '2'
    retry-delay-seconds: '5'
```

## Enforcement and exceptions

The shared runtime checker rejects runner jobs without a literal limit and
known dependency installers invoked raw from workflow `run` steps. A necessary
exception remains genuinely bounded and records an owner, maximum duration,
review trigger, and reason beside the command:

```yaml
# ci-runtime: exception owner=release max=10m review=tool-change reason=upstream-installer-owns-cleanup
timeout --kill-after=10s 600s tool install
```

The checker reconstructs backslash-continued shell commands before inspection
and parses the GNU `timeout` option operands separately from its deadline
operand. Unitless deadlines are seconds. It verifies that the enforced timeout
does not exceed the declared maximum; an annotation alone waives nothing.
Exceptions are for bootstrap or platform constraints, not convenience.
Synthetic hung-process tests and workflow fixtures gate changes to the shared
runner and checker.

## Envelope-versus-job arithmetic

A bounded envelope must fail at its own step, inside documented headroom —
never by tripping the job wall, which cancels the job and skips
`!cancelled()`-gated report uploads. The checker therefore sums, for every job
that calls `bounded-command` or `bounded-dependency-install`, the worst case of
each envelope — `attempts × (timeout-seconds + termination-grace-seconds)` plus
`(attempts − 1) × retry-delay-seconds` — together with the literal
`timeout-minutes` of the job's other steps. That sum plus 60 seconds of
headroom for checkout, setup, cache custody checks, and save (the
[ENG-0269](../decisions/ENG-0269-trusted-dependency-reuse.md) enclosure rule)
must fit inside the job's `timeout-minutes`. Envelope inputs and sibling step
timeouts must be literal integers; an expression fails closed because the
arithmetic cannot be verified.

Dependency download reuse is layered around the same bounded cold path by the
[dependency reuse policy](dependency-reuse-policy.md); a cache hit never removes
the installer deadline or lockfile verification.
