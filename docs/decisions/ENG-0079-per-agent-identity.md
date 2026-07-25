# ENG-0079: Agent identity is per agent — the harness is detected, the agent is pinned

**Status:** Proposed
**Date:** 2026-07-25
**Issue:** qwts/playbook-engineering#79

## Context

[ENG-0016](ENG-0016-agent-pr-bot-identity.md) gave each *harness* a GitHub App
so agent PRs are reviewable by a human, and
[ENG-0045](ENG-0045-agent-environments-are-bot-territory.md) hardened that by
making the worktree's directory dictate the App. Both assume one agent per
harness.

That assumption broke as soon as two Claude models worked in the same repo.
`qwts-claude-fable-agent` reviewed [quorum#9](https://github.com/qwts/quorum/pull/9);
`qwts-claude-opus-agent` follows. Both run under Claude Code, both work in
`~/.claude/worktrees`, and neither the environment nor the directory can tell
them apart — the environment carries the tool, not the model.

The pin already worked: a worktree with `qwts.agentApp` set authored, pushed,
and opened PRs as the pinned App with no code change, because
`setup-worktree.mjs` reads the pin ahead of detection and the `gh` shim reads
its slug back out of the credential helper. What did not work was *knowing*:
`tools/repos/drift.mjs` verified four hardcoded Apps, so an identity outside
that list was never checked against any repository. An App can therefore be in
daily use while nothing verifies it is installed where it will push, and the
drift report stays green until a push fails mid-task.

## Decision

1. **Identity is per agent, not per harness.** One GitHub App per agent that
   authors work — including two agents in the same harness.
2. **Resolution is two-level: the harness detects, the pin refines.** The
   environment and the worktree's territory answer *which tool is running*,
   which they can always know. The pin `git config --worktree qwts.agentApp
   <slug>` answers *which agent inside that tool*, which the environment cannot
   know without being taught a model name it has no reason to carry. Explicit
   `--app` and `GH_AGENT_APP` outrank both, unchanged.
3. **The roster is data.** [`governance/agents.json`](../../governance/agents.json)
   lists every identity with its harness and status. Drift verifies exactly the
   active roster, so registering an agent is what makes it checked, and a
   retired agent keeps its row — offboarding, not deletion, matching the repo
   manifest.
4. **This amends, and does not rewrite, ENG-0016 and ENG-0045.** ENG-0016's
   "one App per harness" and ENG-0045's "the directory dictates the App" remain
   correct at the level they describe: the directory still dictates the
   *harness*, and territory still decides whether a worktree is bot territory
   at all. What changes is that the harness is no longer the whole identity.
5. **The `WorktreeCreate` hook stays harness-level.** It runs before a session
   exists, so no model is known; it resolves the harness and the agent is
   pinned afterwards, or exported by the launcher.

## Why

The alternative was teaching the environment to carry the model — a variable
set by each launcher, read by `detect-harness.mjs`. It fails the same way
every "the agent must remember a step" mechanism in ENG-0045 failed: it is one
more thing to configure per tool, it is silent when missing, and its failure
mode is the wrong identity rather than no identity. The pin is explicit,
lives in the worktree it describes, is already read by every consumer, and is
visible in `git config` when someone asks why a commit is attributed the way
it is.

Making the roster data rather than code is the same move
[ENG-0038](ENG-0038-governance-reconciler.md) made for repositories: the check
is only as good as its list, and a list inside tooling is one nobody updates
when they create an App in a browser at 11pm.

## Consequences

- Creating an agent App gains one step: register it in the roster. Skipping it
  is now the *only* way an identity goes unchecked, and it fails visibly the
  moment drift runs.
- Drift's per-repo check count grows with the roster. Every active agent is
  expected on every active or onboarding repo; an agent that should not reach
  a repo is a reason to reconsider the agent, not to narrow the check.
- Authorship in history becomes finer-grained: `qwts-claude-fable-agent[bot]`
  and `qwts-claude-opus-agent[bot]` are distinguishable in `git log`, which is
  what makes per-agent review and per-agent trust possible later.
