# ENG-0128: Agent identity runtime ownership moves to agent-bot-identity

**Status:** Proposed
**Date:** 2026-08-01
**Issue:** qwts/playbook-engineering#128

## Context

The agent identity system began inside this repository because its first
purpose was enforcing `qwts` review policy. It is now a standalone, installed
runtime with a stable CLI. Keeping another runtime under this repository would
create two implementation sources of truth while mixing reusable operational
mechanics with organization-only policy and App configuration.

## Decision

1. **`agent-bot-identity` owns runtime code and operational mechanics.** Its
   installed executable, hook dispatch, credential helper, identity registry,
   token minting, setup, installation, compatibility behavior, and runtime
   tests have one source of truth in that repository.
2. **`playbook-engineering` owns organization governance.** The App roster in
   `governance/agents.json`, its validation, active/retired semantics,
   permissions policy, human-versus-bot boundary, required review rules,
   App-installation coverage, incident expectations, and governed-repository
   integrations remain here.
3. **The boundary is the stable executable contract.** Governance consumers
   invoke `agent-bot`, optionally selected by `AGENT_BOT_BIN`, and fail closed
   on absence, unsuccessful execution, malformed JSON, or missing credentials.
   They do not import runtime modules, vendor a fallback, use a submodule, or
   depend on a standalone checkout path.
4. **Operational documentation has one owner.** This repository documents
   only `qwts` policy and integration contracts and links the standalone
   runtime at commit
   `9ff7ce00b6a6945c7f249cf7a6ebf37cf58e86ee` for installation, CLI reference,
   hooks, compatibility, and troubleshooting.
5. **Historical policy remains authoritative.** This record supersedes only:
   ENG-0016 decision 3's local minting-tool location; ENG-0045 decisions 5 and
   6 plus their implementation-location consequences; and any implication in
   ENG-0079 or ENG-0081 that runtime mechanics are implemented or operated by
   this repository. Their identity, territory, roster, execution-provenance,
   credential-isolation, and review policies remain in force.

## Why

A process boundary makes the reusable runtime independently installable and
testable while preventing governance code from reaching into implementation
internals. Leaving the roster here keeps organization slugs, repository
coverage, and review policy out of a generic runtime. A vendored fallback or
submodule would preserve two release surfaces and defeat the ownership change.

## Consequences

- Machines and CI that run local governance tools must install a compatible
  `agent-bot` executable or set `AGENT_BOT_BIN` explicitly.
- The playbook test suite validates its CLI adapter and governance behavior but
  no longer executes the standalone runtime's tests.
- Runtime changes ship from `agent-bot-identity`; policy, roster, coverage, and
  governed integration changes ship from this repository.
- The accepted history still contains old implementation paths. Those paths
  are evidence of the superseded design, not supported runtime instructions.
- Coordinated changes across both repositories require separately reviewable
  releases, with the stable CLI contract as their compatibility seam.

## Amendment — 2026-08-16: two cold-start classes

Decision 3 still governs governance consumers and every durable host. It does
not describe a session whose committed hooks are already on disk and whose
runtime is not. That class is named here
([#227](https://github.com/qwts/playbook-engineering/issues/227)). The
original text stays as written. Decisions 1, 2, 4, and 5 stand unchanged.

1. **Two classes.** A **durable host** is a machine the owner will keep and
   finish installing: source bootstrap, organization profile, credentials,
   optional supervisor, then the stable CLI. An **uninstalled or ephemeral**
   session is one where committed harness hooks are present and the installed
   runtime is absent or unusable — a cloud offload, a host that has not been
   bootstrapped, or the `agent-bot-identity` checkout opened as a workspace
   before install.
2. **Absence is not no policy.** A missing installed hook binary is not a
   license to run without identity policy. Identity hooks have an explicit
   uninstalled mode. The mode is harness-neutral. Governance consumers still
   fail closed on a missing `agent-bot` (decision 3).
3. **No human-attributed GitHub writes.** An uninstalled or ephemeral session
   must not commit, push, open a pull request, or otherwise write to GitHub as
   the human account. Those writes remain identity incidents under
   [ENG-0016](ENG-0016-agent-pr-bot-identity.md). Local reads and unpublished
   local edits are not GitHub writes.
4. **Safety does not require a durable install.** Being safe in this class
   does not require `pass-cli`, a supervised daemon, or a completed durable
   bootstrap. Completing identity — minting a bot token and publishing as that
   bot — still requires the durable-host journey.
5. **This repository ships no hook or bootstrap code.** Runtime
   implementation is
   [agent-bot-identity#122](https://github.com/qwts/agent-bot-identity/issues/122)
   under [epic #187](https://github.com/qwts/playbook-engineering/issues/187).

Consequences of the amendment:

- Cloud offload and opening the identity checkout before install are no
  longer undefined. They are the uninstalled class and must not publish as
  the human.
- An ephemeral session that cannot mint a bot token cannot finish a pull
  request. That is the accepted cost of never writing as the human.
- Decision 3 is not a back door for governance to vendor runtime modules on
  an uninstalled machine.

## References

- [Agent bot identity governance](../reference/agent-bot-identity.md)
- [Agent bot organization operations](../reference/agent-bot-operations.md)
- [`agent-bot-identity` runtime](https://github.com/qwts/agent-bot-identity/tree/9ff7ce00b6a6945c7f249cf7a6ebf37cf58e86ee)
