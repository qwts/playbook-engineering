# CI execution policy

Every governed repository keeps its agreed validations: agents check drafts
locally, ready PRs prove their head, the queue validates the exact candidate,
and `main` reuses queue evidence. Public-fork workflows never run.

This baseline comes from
[ENG-0004](../decisions/ENG-0004-centralize-shared-cicd.md) and inherited under
[ENG-0008](../decisions/ENG-0008-shared-sop-inheritance.md). Repositories map
existing gates onto its lanes; only timing and deduplication change.

Release-input policy is repository-specific. A source PR supplies the inputs
required by that repository; a generated release projection consumes them and
proves the resulting release state. CI never requires a generated projection
to retain inputs it was designed to consume.

## Runtime actor boundary

Allowed runtime actors are:

- the human owner `qwts`;
- the release/versioning App `chores-dumb` (runtime actor
  `chores-dumb[bot]`);
- Dependabot (runtime actor `dependabot[bot]`); and
- every active App in [`governance/agents.json`](../../governance/agents.json),
  each of which runs as `<slug>[bot]`.

The immutable action checks both actor fields and rejects `github-actions[bot]`,
Copilot, external contributors, third parties, and retired or unregistered
Apps. Later automation authenticates as an allowed App. GitHub documents its
separate preview control in
[workflow execution protections](https://docs.github.com/en/organizations/managing-organization-settings/actions-policies/workflow-execution-protections).

Keep **Settings → Actions → Policies → Workflow execution protections**
disabled while its actor picker cannot represent the native merge-queue bot
or an event-scoped exception. Do not substitute a repository role: that
authorizes unrelated writers.

Every direct non-CI entrypoint invokes the action in authorization-only mode
before checkout or credentials. Reusable workflows inherit the gated caller
event and token. New direct triggers require this gate and dependency edge.

The merge-queue bot remains unauthorized for `merge_group`, manual dispatch,
PR, and non-`main` push events. Only the resulting native queue push may reach
the post-merge lane, and both actor fields must name that bot.

For public repositories, do not approve a fork workflow after GitHub queues it.
Require approval for all external contributors, keep the default workflow token
read-only, and let the immutable action refuse the external actor if a run is
started. Maintainers move an accepted change onto an allowed,
repository-owned branch before validation.

## Pull-request lifecycle

The gate names in this table are categories and examples, not an allow list.
Every pre-existing required or agreed check remains assigned to the appropriate
lane unless a separate reviewed decision explicitly removes it.

| State or event | Required execution |
| --- | --- |
| Draft PR opened or updated | Do not start GitHub Actions automatically. Before marking ready, the agent runs the repository's agreed local gates, including lint, formatting check, typecheck, unit tests, and docs-gov where configured; a missing category is recorded as not applicable. After the branch is pushed, the agent may explicitly dispatch the complete suite for the exact feature-branch SHA and wait for success. |
| PR marked ready | Verify whether the exact PR-head SHA already has a successful manual complete-suite run. Reuse that evidence and report the stable required gate without rerunning expensive jobs; otherwise run every agreed complete-suite gate. |
| Ready PR updated | Cancel the older PR run. Reuse successful complete-suite evidence only when it names the new exact SHA; otherwise execute every complete-suite gate against the new merge candidate. |
| Source or change PR | Apply the repository's existing release-input contract. Do not invent Changesets or another metadata requirement in a repository that does not use it. |
| Generated release projection | Classify from reviewed repository, base, head, and author configuration. Exempt only consumed-input presence; require deterministic version output, zero pending semantic releases, and every other ready-PR gate. |
| Ordinary automation PR | Apply its normal repository contract. Bot authorship, an updater branch, or a familiar branch suffix does not grant the generated-release exception. |
| PR enters the merge queue | Run every complete-suite gate against the `merge_group` SHA. Earlier evidence cannot replace validation with current `main` and prior queued changes. |
| Queue merge or push to `main` | If that exact SHA has successful merge-group evidence, run only a short smoke/integration check. Otherwise execute every complete-suite gate as the fail-safe. |
| Manual dispatch | Used for exact-SHA preflight validation before PR promotion, diagnostics, release recovery, workflow testing, and an explicit rerun. A CI dispatch defaults to the complete suite. |
| Public-fork PR | Do not run or approve workflows. |

A ready PR always verifies remote evidence. Its stable gate either proves a
successful manual complete-suite run for that exact head SHA or runs the suite;
older evidence never counts.

Approval adds the PR to the required queue rather than merging directly. Its
synthetic SHA runs the complete suite because it is the exact candidate with
the latest target branch. Public forks are never enqueued; accepted changes
first move to an allowed repository-owned branch.

## Workflow contract

CI uses `pull_request`, `merge_group: checks_requested`, default-branch `push`,
and narrowly described `workflow_dispatch` events. Release tag pushes and
operational recovery workflows remain separate; schedules,
`repository_dispatch`, and `pull_request_target` require a documented
repo-local purpose and must still satisfy the actor policy.

Every job, including the stable gate, is skipped while
`github.event.pull_request.draft` is true. The `opened` event remains so a PR
opened directly as ready receives evidence verification and the complete-suite
fallback; `synchronize` remains so each ready update is checked against
exact-SHA evidence.

The preflight verifier accepts only a successful `workflow_dispatch` run of the
canonical CI workflow for `github.event.pull_request.head.sha`, and confirms
that run's stable `CI` job succeeded. Missing, failed, incomplete, or stale
evidence falls through to the complete suite. The agent waits for the manual
run to finish before opening or promoting the PR; an in-progress run is not
evidence.

Use a PR-scoped concurrency group with `cancel-in-progress: true`. Queue runs
use their head ref, replacing obsolete builds without canceling another queue
candidate. One lifecycle workflow prevents equivalent same-commit suites.

Conditional jobs feed stable required gate `CI`, which validates the selected
lane even when expensive children skip. Existing docs-gov, CodeQL, Storybook,
smoke, E2E, compliance, and other agreed contexts remain required unless a
separate reviewed change replaces them.

Advanced CodeQL runs for ready PRs lacking evidence, manual suites, every merge
group, and every `main` push. The default-branch scan remains because queue
analysis cannot own its alerts; language coverage and immutable pins remain.

When a repository requires more than the stable `CI` context, each retained
context must report for the merge-group candidate. PR-head or manual evidence
may avoid a duplicate ready-PR run but cannot satisfy the queue. A rollout
verifies this behavior in the merge box before enabling the queue; it never
deletes an agreed validation to make branch protection pass.

## Changesets, version PRs, and releases

A source PR in a Changesets repository follows that repository's reviewed
release-input contract. The contract may require a Changeset only for shipping
changes, permit an explicit no-release-impact path, or use another local rule.
The migration does not replace that rule with raw file presence.

A generated Version packages PR follows the same ready-head and exact-SHA
lifecycle after the immutable policy action identifies it from
[`governance/release-lifecycles.json`](../../governance/release-lifecycles.json).
Generation automation validates its deterministic version diff and dispatches
no extra equivalent CI run. It must prove semantic `releases.length` is zero,
but it need not retain Changesets already consumed into version and changelog
output. With no non-README Changeset inputs left, the shared semantic counter
reports zero without requiring an empty marker; present inputs still run
`changeset status --output`, and malformed or positive state fails closed.

The projection classification is not a workflow input. Do not add a branch-only
exception or PR-controlled flag. The reviewed catalog must match the GitHub
event's repository, base ref, head ref, canonical head repository, and PR
author. Actor authorization still checks both
`github.actor` and `github.triggering_actor`, and public forks remain refused.
For `merge_group`, the policy parses the queue head ref and head PR's GraphQL
`mergeQueueEntry`, verifies every queue entry included through
that position, and classifies only the current head PR. An earlier generated
projection never overrides a source PR's stricter policy. Manual and post-merge
fallbacks resolve the exact `github.sha` through the read-only
associated-pull-request endpoint. Generated classification requires exactly one
associated PR; mixed generated and source origins fail closed. Missing or
malformed origin evidence fails closed.
Grant only `pull-requests: read`; these lookups neither authorize the actor nor
provide a write credential.

Tagging and release workflows consume the successful complete-suite evidence
for that exact commit instead of rerunning generic lint, format, typecheck,
unit, Storybook, E2E, security, docs-gov, or other merge gates. Before
publishing, they fail closed unless they can prove all of the following:

- the tag and release source resolve to the intended commit on the protected
  default branch;
- that exact commit has successful complete-suite evidence from its merge-group
  run or the fail-safe default-branch run, and its reviewed PR head had a
  successful ready-PR verification gate; and
- version, changeset, tag, and release provenance are internally consistent.

Release-specific work is not duplicate CI and remains mandatory. This includes
building the distributable from the release source, packaging, signing,
notarization, checksums, asset inspection, install or launch checks, and smoke
or E2E coverage that exercises the packaged release mode rather than the
already-tested development build. Repositories may instead promote an
immutable previously built artifact only when they preserve equivalent source,
provenance, integrity, and signing guarantees.

An explicit release-recovery dispatch follows the same rule. If exact-commit
evidence is missing, it may trigger the complete suite for that commit and wait
for success, or stop without publishing; it must not silently treat release
packaging as a substitute for the merge gate.

## Required repository settings

- Require `CI` and every retained independent governance/security context.
- Require merge queue with merge method `MERGE`, grouping strategy `ALLGREEN`,
  one concurrent candidate build, and one PR per merge.
- Allow merge commits in repository settings; the queue controls their use on
  protected default branches.
- Keep workflow-execution protections disabled until GitHub can represent the
  required system actors without authorizing a broad repository role.
- Require approval for all external-contributor workflows and never approve a
  public-fork workflow.
- Keep the default workflow token read-only and retain the action-source allow
  list plus full-commit-SHA pinning.
- Require the exact merge candidate to pass every complete-suite gate.
- Use CodeQL advanced setup so draft, ready, queue, and post-merge execution
  follows the same lifecycle controller. After the workflow lands, choose
  **Settings → Advanced Security → CodeQL analysis → Switch to advanced**,
  disable default setup, dispatch CI, and verify the required `CodeQL` context
  before merging.

Workflow execution protections are currently a GitHub public-preview setting.
Until GitHub can express the governed system-actor exception and provides a
stable management API, its disabled state and the default-to-advanced CodeQL
switch are manual settings with review evidence attached to the rollout PR.

The owner-aware merge path, semantic Changesets contract, required-context
publishers, privileged credentials, repository settings, and concurrency
follow-up are specified in the [rollout checklist](governed-ci-rollout.md).
