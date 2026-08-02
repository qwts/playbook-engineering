# Governed CI release-lifecycle fleet handoff

Verified disposition for every active or onboarding repository in
[`governance/repos.json`](../../governance/repos.json), captured on 2026-08-02
for [#134](https://github.com/qwts/playbook-engineering/issues/134). Refresh live
state before executing a handoff; green workflows alone are not compliance.

The fleet invariant is: change PRs provide the release inputs required by their
repository; generated release projections consume those inputs and prove the
resulting release state. CI never requires a generated projection to retain
inputs it was designed to consume.

## Coverage and disposition

| Repository | Release mechanism | Generated projection | Disposition |
| --- | --- | --- | --- |
| `playbook-engineering` | No versioned artifact | None | Not applicable; do not add a metadata gate. |
| `overlook` | Changesets | `changeset-release/main`, `chores-dumb[bot]` | Repair required; regression source. |
| `image-trail` | Changesets plus version policy | `changeset-release/main`, `chores-dumb[bot]` | Classification and semantic planning repair required. |
| `cartograph` | Changesets plus synchronized npm, Cargo, and Tauri versions | `changeset-release/main`, `chores-dumb[bot]` | Classification and semantic planning repair required. |
| `bookmarkit` | Changesets plus Chrome version synchronization | `changeset-release/main`, target author `chores-dumb[bot]` | Governed-CI and credential repair required. |
| `quorum` | No release metadata system | None | Not applicable; do not add a metadata gate. |
| `agent-bot-identity` | No release metadata system | None | Not applicable; do not add a metadata gate. |
| `codex-rules-editor` | No release metadata system | None | Not applicable; do not add a metadata gate. |
| `playbook-dashboard` | No release metadata system | None | Not applicable; do not add a metadata gate. |

Catalog coverage is a contract test: every active or onboarding manifest entry
must appear exactly once in
[`release-lifecycles.json`](../../governance/release-lifecycles.json).

## `overlook` repair handoff

- **Source contract:** behavior-changing PRs include a Changeset; docs or
  tooling-only PRs may provide a reviewed rationale.
- **Fault:** commit `260fa140` from `qwts/overlook#870` ran
  `npm run check:changesets` in every complete suite. Version packages PR #890
  failed after generation consumed its inputs. An empty marker later made
  regeneration appear green without correcting the lifecycle.
- **Identity:** require base `main`, head `changeset-release/main`, canonical
  head repository `qwts/overlook`, and author `chores-dumb[bot]` from the
  reviewed policy output. Keep both actor checks and fork rejection separate.
- **Implementation:** treat closed PR #892 only as regression evidence. A new
  issue-linked repair runs the repository-owned input validator for source PRs.
  A generated projection validates its version/changelog diff and asserts the
  shared semantic release count is zero, then runs the complete suite without
  the consumed-input presence assertion.
- **Tests:** normal behavior PR with valid and missing metadata; docs/tooling
  rationale; trusted projection; forged branch, author, repository, and fork;
  repeated regeneration with no marker; exact-head preflight; rewritten-SHA
  fallback.
- **Stable contexts:** `CodeQL` from GitHub Advanced Security (`57789`), plus
  `CI`, `E2E gate`, and `Docs governance / docs-gov` from GitHub Actions
  (`15368`). Preserve merge, rebase, and squash methods.
- **Rollout:** pin the merged #134 policy SHA, land the repair, create a real
  source Changeset, and let `chores-dumb[bot]` freshly regenerate a Version
  packages PR without an empty marker. Prove normal missing-input failure and
  generated-projection success independently.
- **Rollback:** revert the repository commit and policy pin together. Remove
  only a newly introduced unpublished context; retain all pre-existing rules.

## `image-trail` repair handoff

- **Source contract:** release-impacting extension source requires a valid
  Changeset or the explicit `no-version-impact` path.
- **Fault:** the current validator recognizes a synchronized version advance,
  but generated identity is not supplied by the canonical policy output. Tag
  planning still uses raw `.changeset/*.md` presence.
- **Identity:** base `main`, head `changeset-release/main`, canonical repository
  `qwts/image-trail`, author `chores-dumb[bot]`.
- **Implementation:** retain `check:version-policy` for source PRs; for the
  projection, run `scripts/validate-version-cut.mjs` and assert zero semantic
  releases. Replace raw tag and release searches with the shared semantic
  action.
- **Tests:** valid, missing, and opt-out source cases; consumed projection;
  repeated regeneration; forged identities; nonzero semantic state; exact-SHA
  fallback.
- **Stable contexts:** `CodeQL` from `57789`; `CI` and `E2E gate` from `15368`.
  Preserve merge, rebase, and squash methods plus every package, Storybook,
  Playwright, acceptance, interop, and workflow-security gate.
- **Rollout/rollback:** land one issue-linked repair pinned to the reviewed SHA
  and regenerate a real Version packages PR. Revert the repair and pin together
  without changing required publishers or merge methods.

## `cartograph` repair handoff

- **Source contract:** shipped behavior and fixes carry release intent; docs,
  tests, and internal tooling may omit it. Do not turn its reviewed PR contract
  into an unconditional raw-file gate.
- **Fault:** tag and release verification use raw pending-file helpers after
  Changesets generation instead of the semantic count and trusted projection
  classification.
- **Identity:** base `main`, head `changeset-release/main`, canonical repository
  `qwts/cartograph`, author `chores-dumb[bot]`.
- **Implementation:** retain synchronized npm, Cargo, Tauri, and changelog
  validation; consume policy classification and semantic zero for tag and
  release planning. The projection still runs docs/traceability, Rust,
  frontend, license/supply-chain, three-language CodeQL, packaging, signing,
  and provenance gates.
- **Tests:** source release intent required/not-required cases; trusted and
  forged projections; repeated regeneration; nonzero semantic state; exact-SHA
  ready evidence and complete fallback.
- **Stable contexts:** `CodeQL` from `57789` and `CI` from `15368`. Preserve
  merge and squash methods; rebase remains disabled.
- **Rollout/rollback:** open a scoped issue-linked repair without overlapping
  unrelated harness PR #296. Revert code and pin together if needed; retain
  ruleset publishers and merge methods.

## `bookmarkit` repair handoff

- **Source contract:** user-visible features and fixes require a Changeset;
  docs, tests, and internal tooling may omit one.
- **Fault:** governed lifecycle classification is absent; version automation
  accepts human PAT and `GITHUB_TOKEN` fallbacks, and tag planning uses raw file
  presence. The projection therefore lacks a trustworthy author contract and
  exact-SHA governed validation.
- **Identity:** target base `main`, head `changeset-release/main`, canonical
  repository `qwts/bookmarkit`, author `chores-dumb[bot]` after removing PAT and
  repository-token write fallbacks.
- **Implementation:** preserve version, notices, formatting, lint, tests,
  Chrome build, Storybook, packaging, and workflow-security gates. Add Advanced
  CodeQL, gate direct entrypoints, use only `CHORES_DUMB_CLIENT_ID` plus
  `CHORES_DUMB_PRIVATE_KEY` at write boundaries, and consume canonical
  projection and semantic-count output.
- **Tests:** all lifecycle and release cases above plus credential absence,
  unauthorized actor, fork, direct-entrypoint ordering, stable contexts, and
  rewritten-SHA fallback.
- **Stable contexts:** repair `CodeQL` to publisher `57789` and add `CI` from
  `15368` only after both publish. Preserve merge, rebase, and squash methods.
- **Rollout/rollback:** do not overlap unrelated harness PR #121. Open an issue-
  linked draft migration, validate exact head, then repair the ruleset. Roll
  back code, pin, and only newly added contexts together.

## Repositories without release metadata

`playbook-engineering`, `quorum`, `agent-bot-identity`,
`codex-rules-editor`, and `playbook-dashboard` are explicit negative contract
tests: `release_metadata_system=none`, `release_gate_mode=not-applicable`, and
no generated projection. Their existing lifecycle, actor, fork, exact-SHA,
CodeQL, deployment, and stable-context gates remain intact. A migration must
not add Changesets, a release-file check, or a bot exception to them.

Preserve each repository's enabled merge methods. Verify Workflow execution
protections through the authorized UI separately from workflow code; do not
infer settings compliance from a green or draft-skipped run.
