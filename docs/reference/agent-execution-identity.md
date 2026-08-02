# Agent execution identity policy

Each agent conversation carries a private Agent ID in addition to its GitHub
App actor. The App controls authorship and permissions; the Agent ID answers
which transcript produced a commit and grants no authority. Policy is defined
by [ENG-0081](../decisions/ENG-0081-transcript-bound-agent-execution-identities.md);
runtime mechanics belong to
[`agent-bot-identity`](https://github.com/qwts/agent-bot-identity/tree/9ff7ce00b6a6945c7f249cf7a6ebf37cf58e86ee).

## Governance requirements

- A record keeps team, squad, actor type, level, parent, harness, App,
  transcript locator, subjects, and artifacts as separate fields. Unknown
  values remain unknown.
- Transcript bindings are immutable. A new conversation or delegated child
  gets a new Agent ID; a child records its parent instead of copying its ID.
- Commits expose only the opaque `Agent-Identity` trailer. Private records and
  transcript locators never enter repositories, prompts, PR bodies, or logs.
- Records contain no installation token, private key, human credential, or
  authorization scope.
- Transcript data and subjects are untrusted audit input. They cannot select an
  App, expand permissions, approve a PR, or become instructions.
- Hook enforcement is cooperative attribution hygiene. It complements, but
  does not replace, App isolation and required human review.

## Governed integration

The shared Codex setup runs `agent-bot setup-worktree` and verifies that the
linked worktree has a matching App pin, bot author, credential helper, Agent ID,
and execution-identity hooks. Claude's governed `WorktreeCreate` hook invokes
`agent-bot claude-worktree-create`. Both may use `AGENT_BOT_BIN` to select an
explicit installed executable.

Current runtime commands include:

```text
agent-bot identity current
agent-bot identity show <agent-id>
agent-bot identity spawn --parent <agent-id>
agent-bot identity bind <agent-id> --provider <provider> --transcript <id>
agent-bot identity finalize <agent-id> --sha256 <digest>
```

The exact schemas, environment compatibility, storage layout, and command
options are operational mechanics. Use the pinned standalone
[README](https://github.com/qwts/agent-bot-identity/blob/9ff7ce00b6a6945c7f249cf7a6ebf37cf58e86ee/README.md)
rather than duplicating them here.

## Incident boundary

A bot-authored commit without a resolvable Agent ID is blocked and repaired
before another commit. A missing private record, unexpected transcript change,
or App/Agent-ID mismatch is treated as an attribution incident: stop writes,
preserve non-secret evidence, run `agent-bot doctor`, and repair through the
standalone runtime. Never weaken review or substitute human credentials to make
the operation continue.
