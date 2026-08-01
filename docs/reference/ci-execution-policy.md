# CI execution policy

Every governed repository keeps its agreed validation suite: agents check
drafts locally, ready PRs prove their head, the merge queue validates the exact
candidate with current `main`, and `main` reuses successful queue evidence.
Repository-level
GitHub Actions Policy blocks every actor except `qwts`, `chores-dumb[bot]`,
`dependabot[bot]`, and the active registered `qwts-*-agent[bot]` Apps;
public-fork workflows are never approved or run.

This is the CI/CD execution baseline established by
[ENG-0004](../decisions/ENG-0004-centralize-shared-cicd.md) and inherited under
[ENG-0008](../decisions/ENG-0008-shared-sop-inheritance.md). Repositories map
their existing commands and extra gates onto these lanes. The policy changes
timing and deduplication, not the set of agreed validations.

## Repository Actions Policy

Configure **Settings → Actions → Policies → Workflow execution protections**
in every governed repository. The active actor allow list contains:

- the human owner `qwts`;
- the release/versioning App `chores-dumb` (runtime actor
  `chores-dumb[bot]`);
- Dependabot (runtime actor `dependabot[bot]`); and
- every active App in [`governance/agents.json`](../../governance/agents.json),
  each of which runs as `<slug>[bot]`.

Do not allow `github-actions[bot]`, Copilot, a repository role, external
contributors, or another third party to initiate workflows.
Automation that must initiate a later workflow authenticates as an allowed App.
The namespace pattern describes the allowed class but is not itself the allow
list: retired or unregistered matching Apps remain unauthorized. GitHub
evaluates this policy before a runner starts; an immutable trusted revision of
the CI-policy action performs a secondary fail-closed check of both
`github.actor` and `github.triggering_actor`. GitHub documents the feature in
[workflow execution protections](https://docs.github.com/en/organizations/managing-organization-settings/actions-policies/workflow-execution-protections).

Allow `merge_group` alongside each repository's governed events. This does not
expand the actor list: both actor fields must still be registered above.

For public repositories, do not approve a fork workflow after GitHub queues it.
The actor policy must refuse the external actor. Maintainers move an accepted
change onto an allowed, repository-owned branch before validation.

## Pull-request lifecycle

The gate names in this table are categories and examples, not an allow list.
Every pre-existing required or agreed check remains assigned to the appropriate
lane unless a separate reviewed decision explicitly removes it.

| State or event | Required execution |
| --- | --- |
| Draft PR opened or updated | Do not start GitHub Actions automatically. Before marking ready, the agent runs the repository's agreed local gates, including lint, formatting check, typecheck, unit tests, and docs-gov where configured; a missing category is recorded as not applicable. After the branch is pushed, the agent may explicitly dispatch the complete suite for the exact feature-branch SHA and wait for success. |
| PR marked ready | Verify whether the exact PR-head SHA already has a successful manual complete-suite run. Reuse that evidence and report the stable required gate without rerunning expensive jobs; otherwise run every agreed complete-suite gate. |
| Ready PR updated | Cancel the older PR run. Reuse successful complete-suite evidence only when it names the new exact SHA; otherwise execute every complete-suite gate against the new merge candidate. |
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

A changesets or version-packages PR follows the same lifecycle: validate its
head, then its merge-group candidate. Generation automation validates only its
deterministic version diff and dispatches no extra equivalent CI run.

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
- Allow the `merge_group` event in Actions Policy without adding a GitHub-owned
  actor; the enqueueing user or registered App must remain authorized.
- Require the exact merge candidate to pass every complete-suite gate.
- Keep the repository Actions Policy active, not in evaluate mode.
- Use CodeQL advanced setup. GitHub does not expose default setup's internal
  `github-advanced-security[bot]` actor in the Actions Policy picker. After the
  workflow lands, choose **Settings → Advanced Security → CodeQL analysis →
  Switch to advanced**, disable default setup, dispatch CI, and verify the
  required `CodeQL` context before merging.

Actions Policy is currently a GitHub public-preview setting. Until GitHub
provides a stable management API used by the governance reconciler, actor/event
configuration and the default-to-advanced CodeQL switch are manual settings
with review evidence attached to the rollout PR.
