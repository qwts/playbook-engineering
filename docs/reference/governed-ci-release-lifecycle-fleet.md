# Governed CI release-lifecycle fleet handoff

Where each governed repository stands against the release-lifecycle policy in
[ENG-0004](../decisions/ENG-0004-centralize-shared-cicd.md), and what a consumer
repository has to do once that policy merges. The policy itself is in the
[CI policy](ci-execution-policy.md#changesets-version-prs-and-releases); this
page does not restate it.

Captured on 2026-08-02 for
[#134](https://github.com/qwts/playbook-engineering/issues/134). Refresh live
state before executing a handoff — a green workflow is not evidence of
compliance.

## Disposition

Every active or onboarding entry in
[`governance/repos.json`](../../governance/repos.json) appears exactly once in
[`release-lifecycles.json`](../../governance/release-lifecycles.json), which is
the machine-readable source for the mechanism, source-input policy, and
generated-projection identity of each. Coverage is a contract test.

| Repository | Release mechanism | Disposition |
| --- | --- | --- |
| `overlook` | Changesets | Repair required — regression source. |
| `image-trail` | Changesets plus version policy | Repair required. |
| `cartograph` | Changesets plus synchronized npm, Cargo, and Tauri versions | Repair required. |
| `bookmarkit` | Changesets plus Chrome version synchronization | Repair required, plus credential cleanup. |
| `playbook-engineering` | None | Not applicable. |
| `quorum` | None | Not applicable. |
| `agent-bot-identity` | None | Not applicable. |
| `codex-rules-editor` | None | Not applicable. |
| `playbook-dashboard` | None | Not applicable. |

## Repair handoff for a Changesets repository

The four repairs are the same work against different local gates. Each is its
own issue-linked PR in its own repository; this one does not modify them.

1. Pin the merged #134 policy revision and grant the CI workflow
   `pull-requests: read`.
2. Keep the repository's existing source-PR release-input gate exactly as
   reviewed, and run it only for source PRs.
3. For the generated projection, validate the version and changelog diff and
   assert a zero semantic release count through the shared
   [`changeset-release-count` action](../../.github/actions/changeset-release-count/action.yml).
   Replace any remaining raw `.changeset` file-presence check in version, tag,
   and release planning with that action. Decide pass/fail with the shared
   `releaseGateOutcome` from
   [`classify.mjs`](../../.github/actions/ci-policy/classify.mjs) rather than
   re-deriving the source/generated/not-applicable table locally.
4. Prove both directions independently before closing: a source PR missing its
   required input still fails, and a freshly regenerated Version packages PR
   passes without an empty marker file.
5. Leave every other gate, required context, publisher, and enabled merge method
   untouched. Rolling back means reverting the repair and the policy pin
   together.

Repository-specific notes:

- **`overlook`** — the regression is commit `260fa140` from `qwts/overlook#870`,
  which ran `npm run check:changesets` in every complete suite. Closed PR #892
  is regression evidence only; the empty marker it relied on must go.
- **`image-trail`** — `check:version-policy` already recognizes a synchronized
  version advance; it needs projection identity from the policy output, and tag
  planning still reads raw `.changeset/*.md`.
- **`cartograph`** — scope the repair so it does not overlap harness PR #296.
  Synchronized npm, Cargo, Tauri, and changelog validation stays.
- **`bookmarkit`** — governed lifecycle classification is absent entirely, and
  version automation still accepts human PAT and `GITHUB_TOKEN` write fallbacks.
  Remove those before the projection's author identity means anything. Do not
  overlap harness PR #121.

## Repositories without a release metadata system

`playbook-engineering`, `quorum`, `agent-bot-identity`, `codex-rules-editor`,
and `playbook-dashboard` carry `metadataSystem: "none"` and no generated
projection. They are the negative case: a migration must not add Changesets, a
release-file check, or a bot exception to them, and their existing lifecycle,
actor, fork, exact-SHA, CodeQL, and deployment gates are unchanged.
