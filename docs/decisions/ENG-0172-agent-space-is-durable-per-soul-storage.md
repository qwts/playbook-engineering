# ENG-0172: Agent Space is durable per-soul storage outside bot territory

**Status:** Proposed
**Date:** 2026-08-06
**Issue:** qwts/playbook-engineering#172

## Context

The agent identity runtime now creates one local Agent Space for each
transcript-bound Agent ID. The shipped mechanics establish a directory and
marker, but they do not decide how long that storage belongs to the soul, how
identity finalization affects it, or whether its location changes the bot
territory boundary. Leaving those rules implicit would let later population,
daemon, handoff, and cleanup work redefine the same storage contract.

The contract crosses repositories: `agent-bot-identity` implements the runtime,
while this repository governs execution identities and bot territory under
ENG-0081, ENG-0045, and ENG-0128. It therefore belongs in the ENG decision
home rather than as duplicated runtime documentation.

## Decision

1. **One soul, one Agent Space.** An Agent Space is durable, secret-free local
   storage keyed by one transcript-bound `agent_<uuid>`. The Agent ID is a
   lookup key and grants no authority. Reusing that Agent ID resolves the same
   space; a newly minted or delegated Agent ID receives a different space.
2. **Lifetime follows the soul, not its checkout.** The space survives
   worktree or scratchpad deletion, context compaction, session reuse, and
   execution-identity finalization. Finalization records provenance; it is not
   retirement and does not authorize cleanup.
3. **Retirement is explicit and separate.** Explicit retirement is the only
   lifecycle event that may authorize Agent Space cleanup. No retirement
   command ships today, so spaces are not deleted or archived automatically.
   Retirement mechanics require separate runtime work before they can remove
   or relocate data.
4. **Path selection is user-controlled and deterministic.** Resolution uses
   `AGENT_BOT_SPACES_HOME/<agent-id>` when that override is present. Otherwise
   it uses `$XDG_DATA_HOME/agent-bot/spaces/<agent-id>`, with XDG data home
   defaulting to `~/.local/share`. Agents do not select arbitrary per-space
   roots, and changing the configured root does not imply migration.
5. **Agent Space is outside bot territory.** A space path does not become a bot
   checkout, commit-authority boundary, credential store, or `gh` identity
   boundary. Existing `.<tool>/worktrees` and recognized Claude scratchpad
   territory rules remain unchanged.
6. **Decision and runtime have separate owners.** `playbook-engineering` owns
   this cross-repository contract. `agent-bot-identity` owns Agent Space code,
   CLI behavior, marker schemas, setup, diagnosis, compatibility, and runtime
   tests. Runtime AGENTS and skill material link here and keep only operational
   guidance rather than restating the contract.

## Why

Keying durable storage to the opaque execution identity preserves continuity
across ephemeral worktrees and context windows without turning a data directory
into an authority signal. Separating finalization from retirement avoids data
loss when provenance becomes immutable. Keeping mechanics in the runtime and
policy here maintains the ENG-0128 process boundary and one source of truth for
each concern.

## Consequences

- Worktree deletion and identity finalization can leave durable local data that
  consumes disk until a future explicit retirement flow exists.
- Operators must treat root changes as storage-location changes; the runtime
  does not silently migrate or merge spaces across roots.
- Agent Space contents cannot hold credentials or other secrets. Population
  rows, export packs, and handoff transports inherit that boundary if added.
- Population schemas, a loopback daemon, gist handoff, retirement
  implementation, and content schemas beyond the shipped `space.json` marker
  remain out of scope for this record.

## References

- [ENG-0045](ENG-0045-agent-environments-are-bot-territory.md) — bot territory remains path-based and unchanged
- [ENG-0081](ENG-0081-transcript-bound-agent-execution-identities.md) — the Agent ID that keys each space
- [ENG-0128](ENG-0128-agent-bot-runtime-ownership.md) — runtime and governance ownership boundary
- [Agent Space runtime issue](https://github.com/qwts/agent-bot-identity/issues/36) — shipped behavior and runtime pointer work
- [Agent Space epic](https://github.com/qwts/agent-bot-identity/issues/35) — later population, daemon, and handoff work
