# SOP: Branch, PR, and review workflow

How a change travels from a branch to a merged commit in any `qwts` repo, and
the bar a pull request clears before it merges. Shared baseline under
[ENG-0008](../decisions/ENG-0008-shared-sop-inheritance.md); a repo varies it
only by a documented delta. This is the common denominator already followed by
photos, cartograph, and image-trail — the [inventory](inventory.md) records
where each repo differs.

## Branching (mandatory — extend, don't drop)

- Development is trunk-based. Cut a short-lived branch from the latest `main`;
  never commit directly to `main`.
- One objective per branch and per PR. Unrelated changes go on their own branch,
  so review and revert stay clean.
- Rebase onto the latest `main` before requesting review.

## Opening the PR

- An agent opens its PR under the dedicated bot identity
  ([ENG-0016](../decisions/ENG-0016-agent-pr-bot-identity.md)), never as the
  human account. GitHub does not let a PR's author approve it, so an agent PR
  authored by the human account makes the human-review requirement below
  unsatisfiable.
- Link the PR to its issue with a closing keyword (`Closes #N` / `Fixes #N`), so
  merging the PR closes the issue. Every change traces to an issue — see the
  [issue lifecycle](issue-lifecycle.md).
- Connect the branch and PR through GitHub's Development sidebar, not a text
  comment alone, so the graph is machine-readable.
- "Ready for review" is the definition of done. Do not end a unit of work as a
  lingering draft PR.
- Ship the docs that a change requires in the same PR as the change; they do not
  trail behind in a follow-up.

## The merge bar (mandatory — extend, don't drop)

- CI follows the shared [execution policy](../reference/ci-execution-policy.md):
  agents run fast checks locally before leaving draft, every agreed gate runs on
  ready merge candidates, and a short post-merge check runs only when that exact
  commit was already validated.
- All required status checks are green before merge. A red gate sends the PR back
  without review — fix the gate first.
- At least one approving human review is required. Agent-authored changes are
  never self-merged; a human approves before merge. (Org mandate following the
  2026-07-21 photos incident.)
- Every review thread is resolved before merge in one explicit state: **fixed**
  (name the commit), **deferred** (link a follow-up issue with the reason), or
  **rejected** (give the technical reason). No thread is silently dismissed;
  replies are visible on the thread.
- Unresolved feedback is carried forward, never reopened under a fresh PR to
  escape it.

## Commit hygiene

- Commits are scoped and intentional: push reviewed slices, and leave unrelated
  project state unchanged.
- Review-fix commits stay focused — no opportunistic refactors bundled into a
  response to feedback.
- Comments explain *why*, not *what*.

## Recorded deltas (see the inventory for the full list)

- **cartograph** prefixes branches `feat/ fix/ chore/ docs/` and requires an
  issue to exist before the branch is cut.
- Per-repo CI gates (coverage floors, acceptance-coverage maps, language
  toolchains) are release-and-validation deltas, not workflow changes; they live
  with each repo and in [release and versioning](release-and-versioning.md).

## Changelog

- 2026-07-31 — add lifecycle-aware CI scheduling to the mandatory merge bar.
- 2026-07-23 — agent-authored PRs are opened under the dedicated bot identity
  (ENG-0016), keeping the one-approving-human-review requirement satisfiable.
- 2026-07-22 — initial version; extracted the common branch/PR/review workflow
  from the photos, cartograph, and image-trail working agreements (ENG-0008).
