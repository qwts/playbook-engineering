# Governed CI rollout checklist

Implementation and evidence checklist for adopting the
[CI execution policy](ci-execution-policy.md) without dropping a gate or
mistaking one commit's evidence for another. Overlook PR
[#875](https://github.com/qwts/overlook/pull/875) is the completed user-owned
repository pilot; it is implementation evidence, not a template to copy
without re-inventorying the target repository.

## Inventory before workflow edits

Record all current CI, docs-governance, CodeQL, security, compliance, release,
packaging, signing, and repository-specific gates. Record both runtime actor
fields, every direct workflow trigger, every privileged write, every
downstream-workflow initiator, and the enabled repository merge methods.

Classify the owner before selecting a merge lifecycle:

- organization-owned repositories prefer GitHub's native merge queue and must
  report required checks for `merge_group` candidates;
- user-owned repositories use strict status checks plus the governed
  `chores-dumb[bot]` ready-branch updater because
  [GitHub limits merge queues to organization-owned repositories](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/merging-a-pull-request-with-a-merge-queue).

Do not change enabled merge methods during this rollout.

Inventory the release lifecycle before adding any metadata gate, and record the
result in [`release-lifecycles.json`](../../governance/release-lifecycles.json):

- the release/versioning mechanism and the source PR's existing input rule;
- the generated projection's base ref, head ref, canonical repository, and
  author, or `null` where the repository generates none; and
- whether generation consumes the source inputs before opening its PR.

## Workflow contracts

- Draft PR events start no jobs; local validation is recorded before promotion.
- Ready and updated PRs validate the exact head SHA. User-owned updater changes
  receive a fresh complete suite.
- Organization queue candidates validate the exact `merge_group` SHA.
- A new `main` SHA without successful evidence for that same SHA runs the
  complete-suite fallback. PR-head success, tree equivalence, and an earlier
  `main` success do not count.
- PR concurrency remains PR-scoped with `cancel-in-progress: true`.
- Stable `CI` and `E2E gate` jobs report conditional-lane verdicts without
  removing any independent gate.
- Advanced CodeQL runs through governed CI for every configured language and
  retains a default-branch scan.
- Source PRs keep their repository-specific release-input rule; generated
  release projections skip only consumed-input presence. The classification and
  origin-resolution contract is in the
  [CI policy](ci-execution-policy.md#changesets-version-prs-and-releases) — grant
  the workflow `pull-requests: read` so the policy action can resolve it.

For Changesets repositories, version planning, tag planning, and release
verification all read the semantic `releases.length` emitted by
`changeset status --output`. Empty or frontmatter-only governance changesets
do not create Version packages PRs or block recovery; a positive count fails
closed before a tag or release. Reject raw `.changeset` file-presence checks in
those three lanes — this governs release planning, not the separate gate a
source PR passes to prove release intent. Reuse the
[`changeset-release-count` action](../../.github/actions/changeset-release-count/action.yml)
rather than maintaining three inline parsers; a generated projection that has
consumed its inputs reports zero through it without a manual empty marker, so
repeated force-regeneration remains safe.

## Required checks and publishers

Configure required checks by stable context and actual publisher. GitHub allows
a required status check to be bound to the App that recently published it; the
wrong integration leaves an otherwise green PR blocked.

| Stable context | Required publisher | Notes |
| --- | --- | --- |
| `CodeQL` | GitHub Advanced Security App | Advanced setup; retain code-scanning and code-quality rules. |
| `CI` | GitHub Actions | Aggregate lifecycle verdict. |
| `E2E gate` | GitHub Actions | Require this stable verdict, not transient `E2E`. |
| Docs-governance context | GitHub Actions | Preserve the repository's exact stable context name. |

`chores-dumb[bot]` initiates governed writes but publishes none of these
checks. Retain every additional independent governance, security, compliance,
and repository-specific required context.

## Privileged credential consumers

Every `chores-dumb[bot]` consumer that writes repository state or initiates
another workflow requires both `CHORES_DUMB_CLIENT_ID` and
`CHORES_DUMB_PRIVATE_KEY`. This includes:

- the governed ready-branch updater;
- Version packages PR creation and refresh;
- tag creation;
- release-recovery dispatch;
- governed harness synchronization; and
- any future privileged write or downstream-workflow initiator.

Do not substitute an App ID variable for `CHORES_DUMB_CLIENT_ID`. Do not add
`CHORES_DUMB`, `RELEASE_TOKEN`, or another secret merely for actor
authorization. Plan with read-only credentials, mint a short-lived App token at
the write boundary, and mint again after any wait that could approach one hour.
Never pass App credentials or tokens to third-party actions.

## Manual GitHub settings

Record screenshots or API output for each item; workflow code cannot configure
or prove these settings by itself.

- **Actions → Policies → Workflow execution protections:** disabled while the
  preview cannot express the event-scoped governed system-actor exception.
- **Actions → General → Actions permissions:** selected-action restrictions and
  full-commit-SHA pinning retained.
- **Actions → General → Fork pull request workflows:** approval required for all
  external contributors; public-fork runs are never approved.
- **Actions → General → Workflow permissions:** read-only default token;
  **Allow GitHub Actions to create and approve pull requests** disabled unless
  a reviewed repository exception exists.
- **Rulesets or branch protection:** strict required checks, correct publisher
  integrations, review and thread requirements, and every independent context
  retained.
- **Merge lifecycle:** organization queue settings or user-owned governed
  updater verified without altering enabled merge methods.
- **Advanced Security → CodeQL analysis:** land the advanced workflow, switch
  from default to advanced setup, then verify every configured language and the
  stable `CodeQL` context before relying on it.
- **Secrets and variables:** both chores-dumb secrets present for every
  privileged consumer; obsolete App ID and PAT fallbacks absent.

## Overlook pilot evidence and follow-up

Overlook PR #875 proved empty semantic changesets, fail-closed chores-dumb write
boundaries, required-check publisher binding, exact ready-head validation, and
the complete-suite fallback on the new merge SHA. Its post-merge Version cut
reported zero semantic releases and created no Version packages PR, tag,
release, or duplicate CI dispatch.

During the pilot, replacement run
[#30717806801](https://github.com/qwts/overlook/actions/runs/30717806801)
was created at 20:49:22 UTC while superseded run
[#30717744853](https://github.com/qwts/overlook/actions/runs/30717744853)
was still canceling; the older run finished cancellation at 20:55:54 UTC. This
matches GitHub's documented model in which a replacement can remain pending
while an in-progress member of the concurrency group is canceled. No
deterministic group or expression defect was found, so the policy and reference
workflow stay unchanged.

Open a follow-up with both run payloads only if the same PR group reproducibly
runs two complete suites concurrently, fails to cancel the superseded run, or
starts the obsolete head after the replacement. Queueing while cancellation
drains is observation evidence, not a reason to weaken exact-SHA validation.

## Fleet inheritance after this policy lands

Every active or onboarding repository has a verified release-mechanism
disposition in the
[release-lifecycle fleet handoff](governed-ci-release-lifecycle-fleet.md).
`playbook-engineering` validates and merges the shared policy first. Consumers
then pin its reviewed immutable SHA and execute their repository-specific
repair or retain the explicit not-applicable disposition.
