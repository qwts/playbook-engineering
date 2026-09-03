# ENG-0045: Agent coding environments are bot territory — the worktree's directory dictates the App

**Status:** Superseded by ENG-0339
**Date:** 2026-07-23
**Issue:** qwts/playbook-engineering#45

> **Superseded 2026-09-03 by
> [ENG-0339](ENG-0339-os-account-determines-persona.md).** The macOS account
> running a harness, not the worktree's directory, is bot territory. Decision 1
> ("the directory dictates the App"), decision 3's directory-based human
> default, and decision 6's worktree enforcement — the guard that told an
> agent it may only commit within `.<tool>/worktrees/<repo>` — are struck; that
> enforcement is no longer needed. Decision 2 survives with "territory"
> meaning the account. Decision 4 (the approval backstop) and decision 5 (the
> commit-pinned runtime source of truth) stand and are carried by
> [ENG-0038](ENG-0038-governance-reconciler.md) and
> [ENG-0128](ENG-0128-agent-bot-runtime-ownership.md). The text below is kept
> unchanged as the reasoning trail.

## Context

[ENG-0016](ENG-0016-agent-pr-bot-identity.md) gave each agent harness its own
GitHub App identity. A day of operating it exposed three failure classes:
environment-marker detection cannot distinguish an editor's *agent* from a
*human* in that editor's terminal (converting human checkouts to bot
identity); any step agents must remember fails in practice (Codex posted PRs
and comments as `qwts` because `gh` required a manual token step); and ad-hoc
redesigns of a working system caused more damage than the flaws they chased.
This record settles the model permanently so it is never re-derived.

## Decision

1. **The directory dictates the App.** A linked worktree under a
   `.<tool>/worktrees/` path belongs to `qwts-<tool>-agent` — regardless of
   which process created it (the IDE, the agent, or a human command) and
   regardless of ambient environment: `.claude/worktrees` →
   `qwts-claude-agent`, `.codex/worktrees` → `qwts-codex-agent`,
   `.vscode/worktrees` → `qwts-vscode-agent`, `.cursor/worktrees` →
   `qwts-cursor-agent`. Location is the identity signal; environment markers
   are at most a fallback for tools with no worktree directory convention.

   **The segment is the signal; the root above it is not.** `~` is the usual
   home for these directories, not a requirement. A workstation whose boot
   volume cannot hold agent worktrees keeps them on
   `/Volumes/<drive>/.claude/worktrees` — a fact about that machine's disks,
   never a statement about who owns the work. Anchoring the rule to `$HOME`
   demoted every worktree on such a machine to human territory, where the shim
   refused to run and the agent fell back to the human's stored credentials:
   the exact outcome this decision exists to prevent. The accepted tradeoff is
   that a checkout containing a literal `.<tool>/worktrees/` path reads as
   territory.
2. **Inside bot territory, everything is the bot.** Commits and pushes via
   the per-worktree config the post-checkout hook writes; PRs, comments, and
   all other `gh` actions via a `gh` shim that resolves identity from that
   same worktree config. Agents carry zero conventions — no flags, no
   environment variables, no steps to remember. Agent-first means the default
   serves the common actor.
3. **Everywhere else is the human's, stock.** No interception, no
   configuration, and deliberately **no escape hatches or kill switches**:
   the human does not perform git or `gh` actions inside bot territory. That
   policy dissolves the only edge case machinery would otherwise serve.
4. **Backstop:** governed repos set `required_approving_review_count: 1`, so
   an impersonated (`qwts`-authored) PR cannot merge — `qwts` cannot approve
   `qwts`. Anything that slips past every layer arrives quarantined.
5. **This repository is the runtime source of truth.** A machine-local
   `~/.local/bin/playbook-engineering` launcher records a verified checkout
   and exact commit. Installed hooks and shims dispatch through it and refuse
   dirty, missing, or advanced checkouts until the user explicitly selects a
   clean commit again. No installed integration embeds a checkout path.
6. **The agent side of the boundary is enforced.** A machine-wide
   `pre-commit` guard (historically tools/agent-bot/hooks/pre-commit, now owned
   by the runtime per [ENG-0128](ENG-0128-agent-bot-runtime-ownership.md), shipped with this
   record) blocks a commit when the process carries agent-only environment
   markers, the commit would be attributed to the human, and the repo has a
   GitHub remote — telling the agent it may only commit within
   `.<tool>/worktrees/<repo>`. Humans are never evaluated (agent-only
   markers, never editor markers); bot-attributed commits pass; remoteless
   scratch repos are exempt. The asymmetry with decision 3 is deliberate:
   agents get machinery, the human gets trust.

## Consequences

- Two implementation gaps become required work under this record: identity
  resolution in tools/agent-bot (the historical local path superseded by
  [ENG-0128](ENG-0128-agent-bot-runtime-ownership.md)) must become path-first (today's merged code
  resolves by environment markers), and the `gh` shim exists only as an
  unreviewed machine artifact until it lands here.
- The human obligation in decision 3 is policy, not tooling — it is stated,
  documented, and deliberately unenforced. Building overrides for it is out
  of scope by decision, not by omission. The agent obligation, by contrast,
  is tooling-enforced (decision 6); agents identified only by editor-style
  environments escape the guard, and decision 4 covers them.
- The shim is PATH-level and fails open (a process that misses the PATH entry
  runs `gh` as the human). Accepted; decision 4 is the mitigation.
- A new agent tool joins by convention, not code review of the model: its
  worktree directory pattern plus a registered App.
- Multiple clones are resolved explicitly. If the selected checkout is gone,
  an interactive launcher lists verified clones and asks the user to choose;
  unattended callers fail with the same list and selection command. With no
  clone, the launcher fails and instructs the user to clone this repository.

## References

- [ENG-0016](ENG-0016-agent-pr-bot-identity.md) — the per-harness bot identities this record scopes
- [Agent bot identity reference](../reference/agent-bot-identity.md) — setup and mechanics
