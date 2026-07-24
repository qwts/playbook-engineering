# Governed repositories

The single source of truth for **which repositories this playbook governs** is
the manifest [`governance/repos.json`](../../governance/repos.json). This page is
its human-readable view: the table below is generated from that manifest by
[`tools/repos/repos.mjs`](../../tools/repos/repos.mjs) and gated in CI, so the
list can never silently drift from the machine-readable record the way the older
scattered prose did.

## How scope works

Governance is **inherit-by-default** ([ENG-0008](../decisions/ENG-0008-shared-sop-inheritance.md)):
a repository under the `qwts` account follows the shared baselines the moment it
exists — silence means baseline, not exemption. The manifest does **not** change
that. It is a *registry* of the governed universe with per-repo metadata
(visibility, shared-CI adoption, and each repo's recorded delta), **not** an
allowlist that a repo must appear in to be governed. A new `qwts` repo is
governed on day one; the rule this page adds is only that it must also be
*recorded* here, so the set is knowable in one place.

Removing a repo is therefore an act of **offboarding**, not deletion: a repo that
leaves the account or is retired keeps its row with `status: retired`, so the
record of what was once governed survives — the same supersede-don't-erase
discipline the [ENG series](../decisions/README.md) uses for decisions.

## How to add or remove a repo

Every operation is a manifest edit followed by a regenerate. Never edit the
generated table below by hand.

1. **Edit** [`governance/repos.json`](../../governance/repos.json):
   - **Onboard** — add a repo object with `status: "onboarding"` while it aligns
     to the baselines, then flip it to `"active"` once it conforms.
   - **Offboard** — flip the repo's `status` to `"retired"`; do not remove the row.
   - **Record a variance** — put the one-line difference in the repo's `delta`.
2. **Regenerate** the table: `node tools/repos/repos.mjs --write`.
3. **Verify**: `node tools/repos/repos.mjs check` passes (CI runs the same check;
   an un-regenerated edit fails it).
4. **Commit** the manifest and this doc together in the same PR.

### Manifest fields

- `name` — the repository name under the `qwts` account (unique).
- `visibility` — `public` or `private`.
- `status` — `active`, `onboarding`, or `retired`.
- `sharedCi` — whether the repo consumes the reusable docs-governance workflow
  (`.github/workflows/docs-governance.yml`) at `@v1`.
- `delta` — the one-line variance this repo carries from the shared baseline, or
  empty for a pure consumer. Deltas are surveyed in
  [the SOP inventory](../sop/inventory.md).
- `note` — optional free-text context.

## Drift detection

The manifest is checked against **live GitHub**, not just against this repo's
docs, by `tools/repos/drift.mjs` (read-only; issue #38 phase 1):

```bash
node tools/repos/drift.mjs
```

Per governed repo it verifies the
[baseline files](../sop/repo-baseline-files.md), a default-branch rule
requiring at least one approving review, private vulnerability reporting, and
all four agent-App installations
([ENG-0016](../decisions/ENG-0016-agent-pr-bot-identity.md)). Repos with
`status: active` are expected to conform — their drift sets a non-zero exit
code so CI can gate on it; `status: onboarding` repos report drift without
failing, which is what makes migrating an old repo under governance a declared
state instead of a surprise.

## Reconciling

Drift's write path ([ENG-0038](../decisions/ENG-0038-governance-reconciler.md)):

```bash
node tools/repos/reconcile.mjs            # dry run: plan per repo
node tools/repos/reconcile.mjs --apply    # converge; --repo <name> to scope
```

Three lanes per repo, split by GitHub's permission model: **settings**
(ruleset review count, vulnerability reporting) applied with your token —
Apps on a user account can never hold admin; **seeds** (missing baseline
files from [`governance/baseline/`](../../governance/baseline/) plus the
shared feature form) proposed as a bot-authored PR, so the seeded content is
itself reviewed; **human** steps (repo creation, App installs,
README/LICENSE) printed, never attempted. Only missing files are added —
existing content is never clobbered. Run it from this checkout; onboard a
repo by adding its manifest row, running `--apply`, reviewing the seed PR,
then flipping the row to `active`.

## Governed repositories

<!-- BEGIN GENERATED governed-repos -->
<!-- Generated from governance/repos.json by tools/repos/repos.mjs. Do not edit by hand. -->

*Generated table — to change it, edit `governance/repos.json` and run `node tools/repos/repos.mjs --write`.*

| Repo | Visibility | Status | Shared CI | Delta from baseline |
| --- | --- | --- | --- | --- |
| `playbook-engineering` | public | active | yes | — |
| `overlook` | public | active | no | Version-consistency gate in CI. |
| `image-trail` | public | active | no | Coverage floor 71% lines / 80% branches; acceptance coverage-map update for UI/content changes. |
| `cartograph` | public | active | no | Branch prefixes feat/ fix/ chore/ docs/; issue-before-branch; Rust gate (fmt, clippy -D warnings, test); spec/traceability artifacts in the same PR. |
| `bookmarkit` | public | active | no | — |
| `quorum` | public | active | no | — |
| `agent-bot-identity` | public | onboarding | no | — |
| `codex-rules-editor` | public | onboarding | no | — |
<!-- END GENERATED governed-repos -->
