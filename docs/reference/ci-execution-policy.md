# CI execution policy

Every governed repository keeps its agreed validation suite but schedules it by
PR lifecycle: agents run fast checks locally before leaving draft, ready pull
requests prove that their exact commit passed every complete-suite gate, and
`main` avoids repeating that suite only when the exact commit already has
successful evidence. Repository-level
GitHub Actions Policy blocks every actor except `qwts`, `chores-dumb[bot]`, and
the active registered `qwts-*-agent[bot]` Apps; public-fork workflows are never
approved or run.

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
  `chores-dumb[bot]`); and
- every active App in [`governance/agents.json`](../../governance/agents.json),
  each of which runs as `<slug>[bot]`.

Do not allow `github-actions[bot]`, Dependabot, Copilot, a repository role,
external contributors, or another third party to initiate workflows.
Automation that must initiate a later workflow authenticates as an allowed App.
The namespace pattern describes the allowed class but is not itself the allow
list: retired or unregistered matching Apps remain unauthorized. GitHub
evaluates this policy before a runner starts; an immutable trusted revision of
the CI-policy action performs a secondary fail-closed check of both
`github.actor` and `github.triggering_actor`. GitHub documents the feature in
[workflow execution protections](https://docs.github.com/en/organizations/managing-organization-settings/actions-policies/workflow-execution-protections).

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
| Push or rebase merge to `main` | If that exact SHA has successful ready-PR evidence, run only a short smoke/integration check. Otherwise execute every complete-suite gate as the fail-safe. |
| Manual dispatch | Used for exact-SHA preflight validation before PR promotion, diagnostics, release recovery, workflow testing, and an explicit rerun. A CI dispatch defaults to the complete suite. |
| Public-fork PR | Do not run or approve workflows. |

A ready PR does not substitute local draft validation for remote evidence. The
`ready_for_review` event always creates an evidence-verification run. Its stable
gate passes only after it either proves a successful manual complete-suite run
for the exact PR-head SHA or executes the suite itself. A manual run for an
older SHA never counts. Governed repositories use rebase-only merges and
require the branch to be current with its target, so the validated PR head is
the exact commit merged. Merge queues are not used because GitHub initiates
`merge_group` workflows as a GitHub-owned actor, which this policy intentionally
refuses.

## Workflow contract

The CI workflow uses `pull_request` lifecycle events, a default-branch `push`,
and a narrowly described `workflow_dispatch`. Release tag pushes and
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

Use one PR-scoped concurrency group, such as the workflow name plus PR number,
with `cancel-in-progress: true`. This cancels a superseded draft or ready run
without canceling unrelated PRs. A single lifecycle workflow and concurrency
group prevent equivalent suites from running twice for the same commit.

Conditional jobs feed one stable required gate named `CI`. The gate always
reports a result and checks that the lane selected for the current event
succeeded, so a skipped expensive child job never leaves branch protection
waiting for a context that was never created. Existing independent governance
and security contexts, including docs-gov, CodeQL, Storybook, smoke, E2E, and
repo-specific compliance checks, remain required and remain part of the ready
suite unless a separate reviewed change explicitly replaces them.

When a repository requires more than the stable `CI` context, each retained
context must either report its own evidence-backed ready result or remain
available from the exact-SHA manual run. A rollout verifies this behavior in
the merge box before enabling reuse; it never deletes an agreed validation to
make branch protection pass.

## Changesets, version PRs, and releases

A changesets or equivalent version-packages PR creates a new commit containing
the generated version and changelog changes. Treat that PR as a normal ready
PR: its exact merge candidate passes the complete suite once, either through
preflight evidence or its ready event. The automation that creates or refreshes
the version PR performs only the work needed to generate and validate that
deterministic version diff. It must not also dispatch an equivalent CI run for
the same commit.

Tagging and release workflows consume the successful complete-suite evidence
for that exact commit instead of rerunning generic lint, format, typecheck,
unit, Storybook, E2E, security, docs-gov, or other merge gates. Before
publishing, they fail closed unless they can prove all of the following:

- the tag and release source resolve to the intended commit on the protected
  default branch;
- that exact commit has successful complete-suite evidence and a successful
  ready-PR verification gate; and
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
- Require rebase-only merges and require the branch to be current.
- Do not enable merge queue while GitHub-owned actors are prohibited.
- Require the exact merge candidate to pass every complete-suite gate.
- Keep the repository Actions Policy active, not in evaluate mode.
- If CodeQL default setup cannot follow ready-only timing, migrate to an
  event-controlled advanced workflow without dropping CodeQL coverage or its
  required context.

Actions Policy is currently a GitHub public-preview setting. Until GitHub
provides a stable management API used by the governance reconciler, actor/event
configuration and any default-to-advanced CodeQL migration are manual settings
with review evidence attached to the rollout PR.
