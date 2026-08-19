# Governed repository operations

The operational lanes for the repositories listed in
[governed repositories](governed-repos.md): cloning them locally, checking them
against live GitHub, converging the ones that drifted, and keeping the shared
agent harness current. The manifest and its human-readable table live in that
page; everything you *run* lives here.

## Local clone bootstrap

Clone or refresh every active and onboarding repository under `~/Code` with:

```bash
npm run repos:bootstrap
```

The helper creates `~/Code`, clones missing manifest repositories, verifies each
existing `origin`, fetches and prunes remote references and stale worktree
metadata, then fast-forwards `main`. A checked-out `main` is updated in its
linked worktree; otherwise only the local branch ref moves.

Safety is fail-closed per repository: a non-repository path, unexpected origin,
missing `origin/main`, dirty `main` worktree, or locally ahead/divergent `main`
is reported and left untouched while the remaining repositories continue. The
helper never resets, cleans, stashes, deletes worktrees, or discards branches.
Scope a run or choose another clone root with:

```bash
npm run repos:bootstrap -- --repo overlook
npm run repos:bootstrap -- --code-dir /path/to/Code
```

## Drift detection

The manifest is checked against **live GitHub**, not just against this repo's
docs, by `tools/repos/drift.mjs` (read-only; issue #38 phase 1):

```bash
node tools/repos/drift.mjs
```

Per governed repo it verifies the
[baseline files](../sop/repo-baseline-files.md), a default-branch rule
requiring at least one approving review, private vulnerability reporting,
CodeQL run by the repo's own workflow
([ENG-0149](../decisions/ENG-0149-code-scanning.md)), and the installation of every active agent App in
[`governance/agents.json`](../../governance/agents.json)
([ENG-0079](../decisions/ENG-0079-per-agent-identity.md)). Repos with
`status: active` are expected to conform — their drift sets a non-zero exit
code so CI can gate on it; `status: onboarding` repos report drift without
failing, so migrating an old repo is a declared state, not a surprise.
The marked shared agent-context discovery block is also checked against the
canonical baseline: a missing or stale block is active drift, while the same
gap appears as a tracked onboarding migration state.

## Reconciling

Drift's write path ([ENG-0038](../decisions/ENG-0038-governance-reconciler.md)):

```bash
node tools/repos/reconcile.mjs            # dry run: plan per repo
node tools/repos/reconcile.mjs --apply    # converge; --repo <name> to scope
node tools/repos/reconcile.mjs --promote NAME # live audit, then graduate onboarding
```

Three lanes per repo, split by GitHub's permission model: **settings**
(ruleset review count, vulnerability reporting) applied with your token —
Apps on a user account can never hold admin; **seeds** (missing baseline
files from [`governance/baseline/`](../../governance/baseline/), the shared
[`.codex/`](../../.codex/) and [`.claude/`](../../.claude/) harness
environments, and the feature form) proposed as a bot-authored PR, so the
seeded content is itself reviewed;
**human** steps (repo creation, App installs, README/LICENSE) printed, never
attempted. Only missing files are added — existing content is never clobbered.
The single exception is an existing `AGENTS.md`: reconciliation replaces only
its marked shared discovery block (or its legacy shared-conventions section),
preserving repository-specific context and vendor adapters; it also updates any
touched playbook `blob/master` link to canonical `blob/main`. Run it from this
checkout; onboard a repo by adding its manifest row, running `--apply`, and
reviewing the reconciliation PR. `--promote NAME` performs a fresh live audit
and refuses to flip its manifest status to `active` until every baseline check,
including shared discovery, conforms.

When the settings lane must create a missing ruleset, it preserves the
repository's enabled merge methods and adds a native merge-queue rule only for
an organization-owned repository. User-owned repositories follow the governed
updater fallback in the [CI execution policy](ci-execution-policy.md); asking
GitHub to create an unavailable queue is not a valid reconciliation plan.

## Continuous harness synchronization

The [Governed harness sync workflow](../../.github/workflows/codex-sync.yml)
keeps the shared agent-harness environment — [`.codex/`](../../.codex/) and
[`.claude/settings.json`](../../.claude/settings.json) — current after
onboarding. Seeding only fixes a *missing* file; this lane carries a change to
either layer into repos that already have it. It runs when a managed source
changes on `main`, on dispatch, and weekly as a repair loop. Also available
locally as a read-only comparison:

```bash
node tools/repos/sync-codex.mjs             # dry-run content comparison
node tools/repos/sync-codex.mjs --repo NAME # scope the comparison
```

Use the workflow dispatch to open or update downstream PRs; its repository
secrets keep the shared automation credential out of developer machines. The
`--apply` CLI remains available for recovery but requires an explicit
`chores-dumb[bot]` `GH_TOKEN` and never falls back to a local agent identity.

Synchronization compares blobs and modes; most files are exact replacements.
`.claude/settings.json` applies declared central paths only: values and
deletions propagate while other target settings survive. Invalid JSON or
undeclared source keys fail closed. A target that owns generated entries in a
managed hook adapter declares the file and stable entry marker under
`codexSync.preserveJsonArrayEntries` in the manifest. Preservation is limited
to `.claude/settings.json`, `.codex/hooks.json`, and `.cursor/hooks.json` so
canonical registries and other governed JSON remain byte-identical.
Synchronization starts from canonical shared policy, appends only matching
target array entries, deduplicates exact matches, and never executes downstream
generators with its write credential. This composition is deterministic:
central deletion and reordering still propagate, while a second run produces
no new diff. Drift
uses the stable `governance/harness-sync` branch and a `chores-dumb` pull
request; default branches stay protected. Existing PRs are reconciled even
when the base is current. The source sets `codexSync.enabled: false` because
its root layer is canonical; that manifest field and the local
`sync-codex.mjs` command retain their original names as compatibility
interfaces, not identity boundaries.

Repository-owned adapter surveys and their exact fleet snapshots are recorded
in the [hook composition audits](hook-composition-audits.md). Use those records
to distinguish a target-owned entry that needs a stable preservation marker
from a centrally owned entry that synchronization must replace.

After the source change is reviewed and merged, approve the generated pull
requests from a normal human checkout:

```bash
npm run codex:approve                         # dry-run and validate every PR
npm run codex:approve -- --request-reviews   # ask Codex as the current human
npm run codex:approve                         # wait for clean review evidence
npm run codex:approve -- --apply              # approve and arm auto-merge
npm run codex:approve -- --repo image-trail   # scope any mode
```

The helper uses the current local `gh` session and never selects, stores, or
mints a personal token. Review-request and apply modes refuse bot identities.
Request mode posts the exact `@codex review` trigger only after validating the
pull request, and does not duplicate a pending current-head request from any
human with write, maintain, or admin repository permission. Before approval
the helper requires the exact `chores-dumb` author, stable synchronization
branch, target default branch, source provenance, and managed-file-only diff.
It also requires clean AI-review evidence after the current head commit: a 👍
from
[Codex code review](https://learn.chatgpt.com/docs/third-party/github), or a
current-head [Copilot code review](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/copilot-code-review)
with no inline findings. A new push makes older evidence stale until the
updated head is reviewed. This keeps human approval explicit while removing
the repetitive per-repository commands. Do not place a personal access token
in the synchronization workflow; an unattended action would exercise a human
identity without a fresh human decision.

The workflow requires the same two repository secrets used by every privileged
`chores-dumb` consumer listed in the
[governed CI rollout checklist](governed-ci-rollout.md):

- `CHORES_DUMB_CLIENT_ID` — the Client ID for `chores-dumb`.
- `CHORES_DUMB_PRIVATE_KEY` — that App's PEM private key.

The ready-branch updater, Version packages PR creation or refresh, tag
creation, release-recovery dispatch, this synchronization workflow, and any
future privileged write or downstream-workflow initiator require both values.
An obsolete App ID variable is not a substitute for the Client ID, and
`RELEASE_TOKEN` is not a fallback. Actor authorization remains separate from
stored credentials.

GitHub's token action mints a short-lived installation token for every
repository in the App's `qwts` installation, down-scoped to contents and pull
request writes; the App's release-only Packages and Attestations permissions
do not reach this job. The synchronization script verifies that GraphQL reports
the exact viewer `chores-dumb[bot]` before any write. A missing secret, human
token, or token for another App fails closed. The workflow checkout uses
`persist-credentials: false`, and its built-in `GITHUB_TOKEN` has read-only
contents permission.
