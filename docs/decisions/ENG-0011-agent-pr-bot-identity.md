# ENG-0011: Agent-authored PRs come from dedicated bot identities (GitHub Apps, one per harness)

**Status:** Proposed
**Date:** 2026-07-23

## Context

The [branch/PR/review SOP](../sop/branch-pr-review.md) requires at least one
approving human review on every PR, and agent-authored changes are never
self-merged (org mandate after the 2026-07-21 photos incident). But agents
currently authenticate as `qwts` — the only human account — and GitHub does
not allow the author of a PR to approve it. An agent-authored PR therefore has
no satisfiable review path: `qwts` cannot approve a `qwts`-authored PR, and the
only way to land one is an owner/admin merge, which *bypasses* the review
requirement instead of satisfying it. The root cause is identity, not a
missing workflow step.

## Decision

1. **Agents author under dedicated machine identities — one GitHub App per
   agent harness** (`qwts-claude-agent`, `qwts-codex-agent`,
   `qwts-cursor-agent`, `qwts-vscode-agent`), owned by `qwts` and installed on
   the repositories agents work in. PRs then arrive authored by
   `<app-slug>[bot]`, and `qwts` reviews and approves them as the human the
   SOP already requires. Per-harness rather than one shared bot because PR
   authorship is immutable — attribution not captured at authoring time is
   lost forever — and author-level identity gives machine-queryable
   per-harness metrics (merge rate, review churn) plus independent key
   revocation and repo scoping per harness.
2. **Permissions are minimal and repo-scoped:** Contents and Pull requests
   (read/write), Issues (read/write, for the issue linkage the SOP mandates),
   Metadata (read). The App is installed only on selected repositories, never
   account-wide.
3. **Agents authenticate with short-lived installation tokens** minted by
   `tools/agent-bot/mint-token.mjs`. The App's private key lives outside every
   repository, per the no-secrets rule in the
   [agent conventions](../reference/agent-conventions.md).
4. **The identities never cross:** the human does not author through the bot,
   and the bot never reviews or approves. Setup and day-to-day usage live in
   the [agent bot identity reference](../reference/agent-bot-identity.md).

## Why a GitHub App and not the alternatives

- **A machine user account** would also separate authorship, but costs more
  than it looks: a second credential-and-email set to custody, GitHub's
  one-free-machine-account ToS limit, and a collaborator seat — the exact
  forcing function on which the
  [GitHub account reference](../reference/github-account.md) defers the
  organization decision. It is also indistinguishable from a human in the UI,
  which defeats the audit purpose of a distinct identity.
- **`github-actions[bot]`** exists only inside Actions runners. Local agent
  sessions cannot use it, and PRs created with the workflow `GITHUB_TOKEN` do
  not trigger CI — the required checks would never run.

## Consequences

- `qwts` gets a real approve flow on agent PRs; the SOP's merge bar becomes
  satisfiable instead of admin-bypassed. GitHub's author-cannot-approve rule
  turns from an obstacle into enforcement that a *second* identity looked at
  the change.
- Installation tokens expire after one hour. Minting is one command, but every
  agent task that pushes or opens a PR must mint first, and a long-running
  session may need to re-mint.
- Each App's private key is a standing credential on the workstation — four
  today, one more per future harness. Each is scoped to its installed
  repositories and revocable in one click, but must be custodied like any
  secret: outside repos, file mode 600. Adopting a new harness now includes
  registering its App.
- On a repo with "require approval of the most recent reviewable push"
  enabled, a fixup commit pushed by `qwts` to a bot PR makes `qwts` the last
  pusher and blocks their approval again. In that configuration, review fixes
  flow through the agent, or approval happens before the human push.
- PR authorship is immutable, so agent PRs already opened as `qwts` cannot be
  re-authored. They land by owner merge with a note — the final uses of the
  bypass this record eliminates.
- Authorship in every repo's history now distinguishes not just agent vs
  human but *which harness* (`qwts-claude-agent[bot]` vs `qwts`) — usable as
  evidence in the [ENG-0006](ENG-0006-agentic-primitives-governance.md)
  evaluation loop and any future audit via a plain `author:` query.

## References

- [Agent bot identity reference](../reference/agent-bot-identity.md) — setup and per-task usage
- [Branch, PR, and review workflow](../sop/branch-pr-review.md) — the merge bar this record makes satisfiable
- [GitHub account reference](../reference/github-account.md) — account baseline; why no second user account
