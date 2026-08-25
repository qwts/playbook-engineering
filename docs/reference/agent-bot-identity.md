# Agent bot identity governance

The `qwts` organization uses one GitHub App per agent so bot-authored pull
requests remain eligible for the human approval required by the
[branch, PR, and review SOP](../sop/branch-pr-review.md). This repository owns
the roster and policy; the standalone
[`agent-bot-identity`](https://github.com/qwts/agent-bot-identity/tree/9ff7ce00b6a6945c7f249cf7a6ebf37cf58e86ee)
repository owns runtime code, installation, hooks, token minting, and
troubleshooting ([ENG-0128](../decisions/ENG-0128-agent-bot-runtime-ownership.md)).

## Organization identity model

- Every independently attributable agent that authors work has its own App.
- Harness detection selects a default App; a worktree pin may refine it to a
  model-level App ([ENG-0079](../decisions/ENG-0079-per-agent-identity.md)).
- Agents use short-lived installation tokens. Humans never author through an
  agent App, and agent Apps never approve pull requests.
- Agent work happens in linked bot-territory worktrees. Primary checkouts stay
  human territory ([ENG-0045](../decisions/ENG-0045-agent-environments-are-bot-territory.md)).
- Conversation-level Agent IDs add audit provenance without granting authority
  ([ENG-0081](../decisions/ENG-0081-transcript-bound-agent-execution-identities.md)).

## Roster

[`governance/agents.json`](../../governance/agents.json) is the organization
source of truth. Drift validates every active App against every active and
onboarding governed repository; retired identities keep their rows but leave
the active coverage set.

Current active identities:

- Claude Code: `qwts-claude-agent`, `qwts-claude-fable-agent`,
  `qwts-claude-haiku-agent`, `qwts-claude-opus-agent`, and
  `qwts-claude-sonnet-agent`.
- Codex: `qwts-codex-agent`, `qwts-codex-luna-agent`,
  `qwts-codex-sol-agent`, and `qwts-codex-terra-agent`.
- Other harnesses: `qwts-copilot-agent`, `qwts-cursor-agent`,
  `qwts-devin-agent`, `qwts-muse-agent`, and `qwts-vscode-agent`.

Adding an App requires one roster row with its exact slug, harness, and active
status. Removing access means retiring the row, revoking or narrowing the App,
and verifying drift; never delete history to hide a former identity.

## Permissions and installation coverage

Each App is owned by `qwts`, installed only on selected repositories, and has:

- Contents: read and write.
- Pull requests: read and write.
- Issues: read and write.
- Metadata: read.

No App receives approval authority, account-wide installation, user-to-server
OAuth, or unrelated permissions. Every active App must be installed on every
active and onboarding repository in `governance/repos.json`; a narrower scope
is drift, not a per-agent exception.

## Runtime contract

Governed integrations invoke the installed executable by name or through an
explicit `AGENT_BOT_BIN` override. They never import runtime modules or depend
on a clone path. The stable contracts used here are:

```text
agent-bot setup-worktree
agent-bot mint-token --app <slug> --json
agent-bot claude-worktree-create
agent-bot doctor
```

The mint command's stdout is a credential and must be parsed without logging.
Missing executables, nonzero exits, malformed JSON, and missing tokens fail
closed. Installation and CLI details remain in the pinned standalone
[README](https://github.com/qwts/agent-bot-identity/blob/9ff7ce00b6a6945c7f249cf7a6ebf37cf58e86ee/README.md).
