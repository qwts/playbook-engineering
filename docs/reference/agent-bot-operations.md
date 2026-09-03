# Agent bot organization operations

This runbook covers only the `qwts` policy and incident boundary around agent
Apps. Runtime installation, CLI behavior, hooks, credentials on disk, and
troubleshooting are owned by
[`agent-bot-identity`](https://github.com/qwts/agent-bot-identity/tree/9ff7ce00b6a6945c7f249cf7a6ebf37cf58e86ee).
The roster and permission model are in
[agent bot identity governance](agent-bot-identity.md).

## Cold-start organization profile

Machine bootstrap needs this repository's secret-free profile, not a local
Playbook checkout and not a roster inferred from the current harness. Fetch
the published projection of [`governance/agents.json`](../../governance/agents.json):

```text
https://raw.githubusercontent.com/qwts/playbook-engineering/main/governance/organization-profile.json
```

[ENG-0128](../decisions/ENG-0128-agent-bot-runtime-ownership.md) names two
cold-start classes. A **durable host** is a machine the owner will keep and
finish installing; when mint works, publish as the GitHub App. An
**uninstalled or ephemeral** session — cloud offload, a host with no
install, or the identity checkout opened before bootstrap — must not
publish as `qwts`. It may publish as `ai9d` only when git author (commits)
and `gh` login (pushes and `gh` writes) match that account. Fail closed
when the actor cannot be determined. Safety in that class does not require
`pass-cli` or a daemon; publishing as a bot still requires the durable-host
journey. Runtime hook behavior is
[agent-bot-identity#124](https://github.com/qwts/agent-bot-identity/issues/124).

On a durable host, from an `agent-bot-identity` source checkout (in the
owner's account, so it is human territory):

```bash
curl -fsSL https://raw.githubusercontent.com/qwts/playbook-engineering/main/governance/organization-profile.json \
  | ./agent-bot bootstrap --profile - --with-gh-shim --machine-only
```

A missing, incompatible, or incomplete profile is a blocking dependency. After
changing the roster, regenerate the checked-in file with
`node tools/repos/organization-profile.mjs --write` so the HTTPS document and
the roster cannot drift.

## Registering or changing an App

1. Create the App under `qwts` with the exact roster slug, no webhook, no
   user-to-server OAuth, and only Contents, Pull requests, and Issues read/write
   plus Metadata read.
2. Install it on every active and onboarding repository in
   [`governance/repos.json`](../../governance/repos.json).
3. Add or update its row in
   [`governance/agents.json`](../../governance/agents.json) and regenerate
   [`governance/organization-profile.json`](../../governance/organization-profile.json)
   with `node tools/repos/organization-profile.mjs --write`. Retire old
   identities instead of deleting their history.
4. Store the App ID and private key in the reviewed `pass-cli` store — the
   durable credential home under
   [ENG-0016](../decisions/ENG-0016-agent-pr-bot-identity.md) — and outside
   every repository. Key material leaves the store only for the moment of an
   authorized mint or grant spend.
5. Run the roster tests, governance drift, and `agent-bot doctor` before using
   the App for repository writes.

The App that authors a pull request cannot approve it. The required approval
comes from the human `qwts` account; no bot approval or admin bypass substitutes
for that review.

A bounded human-origin grant lets the identity service spend one named write on
the `qwts` account — an issue comment, an issue state change, a request that a
human review something. Approving, merging, dismissing an approval, and
anything else that would satisfy `required_approving_review_count` are outside
every grant and cannot be added to one
([ENG-0016](../decisions/ENG-0016-agent-pr-bot-identity.md)). The service spends
the grant; the human credential never reaches an agent process. Treat an
*agent-caused* human-account write with no grant receipt behind it the same way
as a human-authored agent pull request: an identity incident. The human's own
direct writes are the ordinary human path and need no receipt.

## Routine verification

Before relying on an installed runtime:

```bash
command -v agent-bot
agent-bot --version
agent-bot doctor
```

Use `AGENT_BOT_BIN` only when a hermetic test or unusual installation needs an
explicit executable. Governance code must call the stable CLI and must never
read a standalone clone's internal modules.

The drift detector mints one token per active roster slug through
`agent-bot mint-token --app <slug> --json`, lists that installation's
repositories, and compares the result with the governed manifest. Token stdout
is secret-bearing: do not print it, include it in errors, or persist it in a
report.

## Failure and incident expectations

- Missing executable, failed mint, malformed grant, missing token, or identity
  mismatch stops the operation before GitHub access.
- A missing App installation is governance drift. Extend installation coverage
  or retire the App; do not bypass the check with human credentials.
- A human-authored agent pull request is an identity incident. Stop writes,
  verify the worktree author, credential helper, hook path, `gh whoami`, and
  Agent ID, then recreate or clearly quarantine the incorrectly authored work.
- An uninstalled or ephemeral session that commits, pushes, or opens a pull
  request as `qwts` — or as any actor that is not `ai9d` — is the same
  incident. A local human-authored commit counts even if it is never
  pushed. Reads and uncommitted working-tree edits do not. `ai9d` never
  reviews or approves.
- A leaked installation token is short-lived but still sensitive: stop sharing
  it and wait for expiry. A leaked private key is rotated immediately, then the
  exposure is investigated and scrubbed.
- Hosted GitHub connectors authenticated as the human remain read-only in the
  governed Codex configuration. Git and bot-authenticated `gh` are the
  sanctioned write paths.
- Live GitHub behavior is reported as passing only when token minting, repository
  access, push/PR attribution, and `gh whoami` were actually exercised.

Operational repair commands and detailed failure diagnosis belong in the
pinned standalone
[README](https://github.com/qwts/agent-bot-identity/blob/9ff7ce00b6a6945c7f249cf7a6ebf37cf58e86ee/README.md),
not in this governance repository.
