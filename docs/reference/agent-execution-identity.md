# Agent execution identity

Each agent conversation gets a private, resolvable Agent ID in addition to its
shared GitHub App actor. The App controls authorship and permissions; the Agent
ID answers which exact transcript produced a commit. Decision:
[ENG-0081](../decisions/ENG-0081-transcript-bound-agent-execution-identities.md).

## Automatic lifecycle

`setup-worktree.mjs` resolves the App through the existing ENG-0079 order,
mints or reuses an execution identity, and writes only its opaque ID to
worktree config as `qwts.agentId`.

- Codex binds `CODEX_THREAD_ID`.
- Claude's `WorktreeCreate` hook binds its `session_id`.
- Other launchers set `QWTS_AGENT_TRANSCRIPT_PROVIDER` and
  `QWTS_AGENT_TRANSCRIPT_ID`.

Git's `post-checkout` hook remains the earliest best-effort setup point, but a
Codex worktree can be created before that hook receives any `CODEX_*` marker.
The shared Codex environment therefore runs
[`ensure-identity.sh`](../../.codex/scripts/ensure-identity.sh) during local
environment setup. That retry can precede the task and its `CODEX_THREAD_ID`,
so it is conclusive about the universal identity boundary — one Agent ID, a
matching App pin and Git author, and a credential helper for the same App —
without making optional provider transcript metadata an availability gate.
Setup also pins `core.hooksPath` to the hooks shipped beside the identity tool,
avoiding a stale canonical-checkout path that would silently omit the commit
trailer. A displaced custom path is preserved and explicitly chained across
Git's client hooks, including Husky-managed checks.

`setup-worktree.mjs` persists whichever App won ENG-0079 resolution as
`qwts.agentApp`. An explicit per-model App such as
`qwts-codex-sol-agent` therefore remains authoritative for later commits,
pushes, and `gh` calls instead of falling back to the generic harness App.

Repeated bound setup in the same provider conversation is idempotent, including
across worktrees on one workstation. Reusing a worktree for another transcript
or repinning it to another App preserves the old record and mints a new one.
A transcript-pending record is not reused automatically because setup cannot
prove two invocations belong to the same conversation.

The machine-wide `prepare-commit-msg` hook appends:

```text
Agent-Identity: agent_00000000-0000-4000-8000-000000000000
```

The exact Git author remains `<app-slug>[bot]`. `post-commit` records the new
commit against the private identity, and `pre-commit` refuses an
agent-attributed GitHub commit when its identity record cannot be resolved.

## Inspect and extend an identity

The current ID is available without exposing its transcript:

```bash
npm run agent:identity -- current
npm run agent:identity -- current --json
npm run agent:identity -- show <agent-id>
```

`show` is intentionally local and private. It displays the provider transcript
locator, structured identity fields, subjects, and artifacts; it never contains
a GitHub credential.

Launchers or orchestrators mint a delegated child and pass the returned ID as
`QWTS_AGENT_ID` to that child:

```bash
npm run agent:identity -- spawn \
  --parent <agent-id> \
  --provider codex \
  --transcript <child-thread-id>
```

The child inherits the parent actor/team defaults but receives a distinct
transcript and immutable Agent ID. A launcher may also provide structured
`--team`, `--squad`, `--type`, and `--level` values; they are metadata, never
credential-selection inputs.

For an unsupported provider, bind the pending record when its locator becomes
available:

```bash
npm run agent:identity -- bind <agent-id> \
  --provider provider-name \
  --transcript provider-transcript-id
```

If an operator truly wants two setup invocations to share one pending record,
`ensure --reuse-pending` makes that ambiguity explicit. Prefer binding the
provider locator.

Record audit subjects and non-secret artifacts explicitly:

```bash
npm run agent:identity -- record <agent-id> \
  --subject github:qwts/playbook-engineering#81 \
  --artifact pull-request:qwts/playbook-engineering#82
```

After the provider transcript is closed, optionally seal a known export digest:

```bash
npm run agent:identity -- finalize <agent-id> --sha256 <64-hex-digest>
```

## Storage and security

Records live at:

```text
${XDG_STATE_HOME:-~/.local/state}/qwts/agent-identities/<agent-id>.json
```

The directory is mode 700 and records are mode 600. Set
`QWTS_AGENT_STATE_HOME` only to relocate the private registry. Do not commit,
sync, or paste it into prompts: provider transcript IDs can be sensitive even
though they are not credentials.

The identity record contains the App slug, bot UID, and the name
`worktree-token`; it never contains an installation token or private key.
Authentication still happens through the existing credential helper and
`gh` shim using short-lived installation tokens. Transcript content and
recorded subjects remain untrusted audit data and cannot authorize an action.

The hooks are cooperative attribution controls, not an adversarial security
boundary: `git commit --no-verify` and a process without agent markers can
bypass them. Enforcing registry resolution inside token minting would create a
structural chokepoint and requires a separate decision.

`status: active` means only that the record has not been finalized. The local
registry does not measure process or provider-session liveness, so dashboards
must not interpret it as presence.

## Failure modes

- **No current ID:** run `playbook-setup-worktree` from the bot
  worktree.
- **Pending transcript:** the provider exposed no locator; bind one before
  finalization.
- **Already bound:** transcript bindings are immutable; a new conversation
  needs a new identity.
- **Missing private record:** setup fails closed instead of writing a trailer
  that cannot be resolved.
