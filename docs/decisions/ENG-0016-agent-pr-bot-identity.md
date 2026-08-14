# ENG-0016: Agent-authored PRs come from dedicated bot identities (GitHub Apps, one per harness)

**Status:** Proposed
**Date:** 2026-07-23
**Issue:** qwts/playbook-engineering#26

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
   tools/agent-bot/mint-token.mjs (the historical local path superseded by
   [ENG-0128](ENG-0128-agent-bot-runtime-ownership.md)). The App's private key lives outside every
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

## Amendment — 2026-08-13: bounded human-origin grants, and `pass-cli` as the durable credential home

Two changes ([#219](https://github.com/qwts/playbook-engineering/issues/219)).
Decision 4 keeps its force, and most of what follows exists to protect it.

1. **The undelegable set.** No grant, broker, daemon, or automation may, on the
   human's behalf, approve a pull request, merge one, dismiss or alter an
   existing approval, or perform any other act that satisfies
   `required_approving_review_count` or the
   [SOP](../sop/branch-pr-review.md)'s human-approval requirement. That set is
   closed to delegation — not "brokered with extra ceremony". It is the
   2026-07-21 photos-incident line: the required approval is a human reading
   the change, and a brokered click is not one. Agent Apps still receive no
   approval authority.
2. **Bounded human-origin grants.** Outside that set, a grant may authorize one
   named write on the human account — an issue comment, an issue state change,
   a review *request* that asks a human to look. Each grant names the soul
   (Agent ID) it is for, the single operation, a digest of the resource it acts
   on, and an expiry. Nothing wider is implied by any of them.
3. **Creation is a human ceremony; spending belongs to the daemon.** Creating
   or widening a grant requires a human-origin ceremony the agent cannot
   complete or simulate. A conversational "yes" is not a ceremony: transcript
   content is untrusted input under
   [ENG-0081](ENG-0081-transcript-bound-agent-execution-identities.md) decision
   8. Approving one grant authorizes exactly that soul, that operation, and
   that resource — never another soul, a wider operation, a different resource,
   or a later run. The daemon or broker performs the act; the agent never
   receives the human credential, and no PAT or OAuth token is returned to an
   agent process.
4. **Grant spends and refusals are receipted, secret-free.** A receipt names
   both principals — which soul asked and which human account acted — plus the
   operation, the resource digest, the outcome with its reason on refusal, and
   the time. It carries no credential material and no store secret.
5. **Grants are harness-neutral.** No grant type, ceremony, or deny-list entry
   is defined for one harness.
6. **`pass-cli` is the durable credential home.** The consequence describing
   each App private key as a standing mode-600 file on the workstation is
   superseded. The durable home for App private keys and for the human
   credentials this toolkit uses is the reviewed `pass-cli` store. Material may
   exist outside that store only for the moment of an authorized mint or grant
   spend, and never persists past it. "Outside every repository" is unchanged,
   as is the no-secrets rule in the
   [agent conventions](../reference/agent-conventions.md).

Reserved, and explicitly not this work: a non-author agent reviewer — a second
roster identity reviewing through App webhooks. It is not part of the grant
broker, and closed
[agent-bot-identity#54](https://github.com/qwts/agent-bot-identity/issues/54)
stays closed, folded rather than revived. Runtime lands in
[#108](https://github.com/qwts/agent-bot-identity/issues/108) (grants) and
[#110](https://github.com/qwts/agent-bot-identity/issues/110) (Pass as home)
under [epic #104](https://github.com/qwts/agent-bot-identity/issues/104), per
[ENG-0128](ENG-0128-agent-bot-runtime-ownership.md).

Consequences:

- For a narrow class of writes, the human moves from approving each act to
  approving each grant. That is a genuine widening of what an agent can cause
  to happen under the human's name, bounded only by the undelegable set, the
  resource digest, and the expiry — so the bounds are load-bearing.
- A grant that turns out to be too coarse is a governance defect, not an
  inconvenience. Widening it is a new ceremony, never an edit to an existing
  grant.
- Custody concentrates. One reviewed store now holds App private keys and human
  credentials together, so losing access to it stops minting and grant spending
  at the same moment. That is accepted in exchange for a single audited home
  instead of a spread of standing files.
- Anyone auditing a human-account write now has two questions, not one: was the
  act inside the grant, and was the grant created by a ceremony. Receipts are
  what make the second answerable.

## References

- [Agent bot identity reference](../reference/agent-bot-identity.md) — setup and per-task usage
- [Branch, PR, and review workflow](../sop/branch-pr-review.md) — the merge bar this record makes satisfiable
- [GitHub account reference](../reference/github-account.md) — account baseline; why no second user account
