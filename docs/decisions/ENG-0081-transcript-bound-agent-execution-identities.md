# ENG-0081: Agent execution identities bind bot actions to provider transcripts

**Status:** Proposed
**Date:** 2026-07-25
**Issue:** qwts/playbook-engineering#81

## Context

[ENG-0079](ENG-0079-per-agent-identity.md) distinguishes independently acting
agents by GitHub App. That is the right external identity and credential
boundary, but it still groups every conversation by one immutable bot actor.
Given a bot-authored commit, the playbook cannot identify which conversation
produced it, open that agent's transcript, distinguish a delegated child, or
connect the transcript to its issues and artifacts.

A display name cannot solve this. Team, squad, role, level, and future
dimensions change independently, while GitHub App slugs and commit authorship
have their own stability rules. The useful identifier is therefore an opaque
lookup key backed by structured private data.

## Decision

1. **GitHub actor and execution identity are separate layers.** The App from
   ENG-0079 remains the external author and authentication principal. Each
   conversation mints an opaque Agent ID whose record names that App and adds
   the conversation-level provenance. Agent IDs grant no authority.
2. **The record is structured; its spelling is not policy.** It carries team,
   squad, actor type, level, parent Agent ID, harness, GitHub App, transcript
   locator, subjects, and artifacts as separate fields. Unknown values stay
   null rather than being guessed from a display name.
3. **A transcript binding is immutable.** A record stores provider plus
   provider transcript ID, never transcript content. Re-running setup in one
   conversation reuses its ID across worktrees on that workstation; a different
   conversation or repinned App mints a new record. Finalization may add a
   transcript digest.
4. **Binding is automatic where the provider exposes identity.** Codex uses
   `CODEX_THREAD_ID`. Claude's `WorktreeCreate` payload supplies `session_id`
   to setup. Launchers use the vendor-neutral
   `QWTS_AGENT_TRANSCRIPT_PROVIDER` and `QWTS_AGENT_TRANSCRIPT_ID` contract.
   An unsupported provider may mint a visibly pending record, but cannot
   finalize until a locator is bound.
5. **Delegation mints, never copies.** A child sharing a worktree receives its
   own Agent ID and records the parent. `QWTS_AGENT_ID` lets that child override
   the worktree's root ID without changing Git or GitHub identity.
6. **Private registry, public lookup key.** Full records live under
   `$XDG_STATE_HOME/qwts/agent-identities` (default
   `~/.local/state/qwts/agent-identities`) with directory mode 700 and record
   mode 600. Worktree config stores only `qwts.agentId`. Commits carry only an
   `Agent-Identity` trailer; a post-commit hook records the commit privately.
7. **Credentials remain leases, not identity data.** The record names
   `worktree-token` as its credential provider and contains no installation
   token, private key, human credential, or authorization scope. Existing
   short-lived, repo-scoped minting and the `gh` shim remain unchanged.
8. **Transcript data is untrusted audit input.** Subjects, sibling-agent
   messages, and transcript content can support lookup but never select an
   App, broaden permissions, approve a PR, or become instructions.

## Why

Encoding every attribute in a username or sequential number makes identity
policy depend on naming and requires a central allocator before local work can
start. An opaque UUID avoids collision and lets the registry provide whatever
human display evolves later. Storing a provider locator instead of copying the
transcript preserves the provider's access control and avoids creating a
second sensitive archive.

This extends ENG-0079 rather than replacing it: App identity answers *which
independently attributable actor*; execution identity answers *which exact
conversation of that actor*.

## Consequences

- Existing bot worktrees need `setup-worktree.mjs` run once before their next
  agent commit; the guard refuses a bot-attributed agent commit whose Agent ID
  has no valid registry record.
- Codex and Claude bind automatically. Other harnesses remain explicitly
  pending until their launchers supply a transcript locator.
- The registry is workstation-local. Cross-machine synchronization would expose
  private transcript locators and requires a separate privacy and custody
  decision.
- Git history gains a stable lookup key without changing the exact
  `<app-slug>[bot]` author GitHub uses for review enforcement.

## References

- [ENG-0016](ENG-0016-agent-pr-bot-identity.md) — short-lived App credentials and the human/bot boundary
- [ENG-0045](ENG-0045-agent-environments-are-bot-territory.md) — automatic worktree enforcement
- [ENG-0079](ENG-0079-per-agent-identity.md) — per-agent App roster and pinning
- [Agent execution identity](../reference/agent-execution-identity.md) — commands, lifecycle, and storage
