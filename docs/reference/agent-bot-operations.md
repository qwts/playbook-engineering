# Agent bot operations — App setup, tokens, shim, failure modes

Operating the bot identities defined in
[agent bot identity](agent-bot-identity.md): creating one GitHub App per agent,
minting installation tokens, installing the `gh` shim, verifying the result, and
the failure modes worth recognizing. The identity model, territory rules, and
worktree machinery live in that document; this one is the runbook for a human
setting an agent up and an agent operating day to day.

Split out of the identity runbook when registering the model-level Apps pushed
it past its token budget for a third time — its own budget note asked for this
split rather than another raise.
## One-time setup (human, in the browser — repeat per App)

1. GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.
   - **Name:** the agent's slug — the harness for a default identity
     (`qwts-claude-agent`) or one agent within it (`qwts-claude-fable-agent`).
     This becomes the `[bot]` author name `git log` shows.
   - **Homepage URL:** any real URL; this playbook repo's URL is fine.
   - **Webhook:** uncheck *Active* — no webhook is needed.
   - **Repository permissions:** Contents *Read and write*; Pull requests
     *Read and write*; Issues *Read and write*. Metadata read-only is added
     automatically. Nothing else.
   - **Identifying and authorizing users** and **Post installation:** leave
     everything blank and unchecked — that is user-to-server OAuth, where the
     App acts *as a signed-in user*; a token authorized by `qwts` attributes
     actions to `qwts`, recreating the self-approval deadlock. Bots only ever
     use installation tokens.
   - **Where can this GitHub App be installed?** Only on this account.
2. Note the **App ID** at the top of the App's page and **generate a private
   key** there. Store the App ID under the App's slug; put the PEM on the
   Proton Pass item titled like the slug in vault **Agent Identities**
   (attachment `private-key.pem`):

   ```bash
   mkdir -p ~/.config/qwts-claude-agent && echo '<app id>' > ~/.config/qwts-claude-agent/app-id
   # fetch/refresh PEM (also done by setup-worktree when missing):
   node tools/agent-bot/ensure-private-key.mjs qwts-claude-agent
   node tools/agent-bot/ensure-private-key.mjs qwts-claude-agent --force
   ```

3. **Install App** (left sidebar) → install on `qwts` → *Only select
   repositories* → **every active and onboarding repo in the manifest** —
   what drift verifies; a subset fails there. Extend it as repos join; tokens
   only ever reach the selected list.
4. **Register it** in [`governance/agents.json`](../../governance/agents.json)
   (slug, harness, `status: active`). Until that lands, drift does not verify
   the App is installed anywhere, and the first symptom of a missed install is
   a push failing mid-task on a repo nobody added.
5. From this checkout:
   `node tools/agent-bot/install-hooks.mjs` (records **this** absolute path)
   and `node tools/agent-bot/install-gh-shim.mjs`. Identity is then
   auto-detected per IDE (see
   [Automating worktrees](agent-bot-identity.md#automating-worktrees-tool-agnostic));
   `GH_AGENT_APP` is only an override. No `gh auth setup-git` — bot pushes
   go through the per-worktree credential helper, and the human's own push
   setup (SSH, keychain, or `gh`) is untouched.

## Per-task usage (agent)

With the [gh shim](#the-gh-shim-prs-and-comments-as-the-bot-automatically)
installed, there is no per-task step: `gh` inside a bot worktree
authenticates as that worktree's bot on its own. The manual mint below
remains for CI and for environments without the shim. Assignment and export
are two steps because `export GH_TOKEN=$(…)` returns `export`'s own status
(0) even when the mint fails, and `gh` treats an empty `GH_TOKEN` as absent —
silently falling back to the stored `qwts` login. A failed mint must abort
the task, never continue as `qwts`.

```bash
GH_TOKEN=$(node tools/agent-bot/mint-token.mjs) || exit 1
export GH_TOKEN
```

The `tools/agent-bot/` paths here are relative to this repository; from any
*other* repo, use the checkout `playbook-home` / `$PLAYBOOK_HOME` points at
([ENG-0004](../decisions/ENG-0004-centralize-shared-cicd.md)).

The tool reads `GH_AGENT_APP` (or `--app <slug>`, or `GH_APP_ID` with either
`GH_APP_PRIVATE_KEY` or `GH_APP_PRIVATE_KEY_PATH` for CI) and finds local
credentials under `~/.config/<slug>/`. The direct private-key value is intended
for a masked multiline Actions secret; local keys remain files with mode 600.

- `gh` gives `GH_TOKEN` precedence over the stored `qwts` login, so
  `gh pr create` (and every other call) now acts as the bot. The PR's author
  is whoever *creates* it — this is the step that matters.
- `git push` needs no token at all in a configured worktree — the
  per-worktree credential helper mints its own on demand.

In a configured worktree, commit attribution and no-signing are already
applied by the post-checkout hook. Set them manually only outside one — a
bot commit signed with the human's GPG/SSH key shows **Unverified**, because
the key does not match the bot's committer email. Name the App first:

```bash
export GH_AGENT_APP=qwts-claude-agent   # the App this task authors as
BOT_UID=$(gh api "users/${GH_AGENT_APP}%5Bbot%5D" --jq .id)
export GIT_AUTHOR_NAME="${GH_AGENT_APP}[bot]" GIT_COMMITTER_NAME="${GH_AGENT_APP}[bot]"
export GIT_AUTHOR_EMAIL="${BOT_UID}+${GH_AGENT_APP}[bot]@users.noreply.github.com" GIT_COMMITTER_EMAIL="${BOT_UID}+${GH_AGENT_APP}[bot]@users.noreply.github.com"
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false
```

Agent checkouts must use **HTTPS remotes**. An SSH remote (`git@github.com:…`)
authenticates the push with the human's SSH key regardless of `GH_TOKEN`,
silently making `qwts` the pusher again.

## The gh shim (PRs and comments as the bot, automatically)

`gh` never reads git config — it uses its stored human login or `GH_TOKEN` —
so without help, a perfectly configured bot worktree still opens PRs as
`qwts`. The shim closes that lane. One machine-wide install:

```bash
node tools/agent-bot/install-gh-shim.mjs
```

It writes `~/.config/agent-bot/bin/gh`, records this checkout in
`playbook-home` (no baked `~/Code/...` path), symlinks to `~/.local/bin/gh`,
and prepends the config bin from `~/.zshenv`. Re-run after moving the
checkout. Outside bot territory, human shells pass through; agent processes
abort before stock `gh` can use the human credential. Territory: any
`.<tool>/worktrees/**` path, else a relocation root, else the credential
helper. Inside, the shim mints the worktree's bot token; a failed mint or
wrong explicit `GH_TOKEN` aborts. `gh whoami` reports token, territory bot,
or human login.

## Verifying it works

```bash
GH_TOKEN=$(node tools/agent-bot/mint-token.mjs) gh api installation/repositories --paginate --jq '.repositories[].full_name'
```

lists exactly the repositories the selected App is installed on. `--paginate`
is load-bearing: without it only the first 30 repositories return, and a repo
missing from that page reads as "not covered" — the verification lies. A PR
opened under `GH_TOKEN` shows the App's `[bot]` as author, and the review
dialog offers `qwts` **Approve** — never offered when `qwts` authored it.

## GitHub connector boundary

The governed [Codex configuration](../../.codex/config.toml) keeps the hosted
GitHub connector enabled for read operations but sets
`destructive_enabled = false` for it. Codex therefore blocks the connector's
write tools, which advertise the destructive hint, so they cannot bypass the
worktree bot identity. Git and the bot-authenticated `gh` shim remain the only
sanctioned GitHub write paths.

The four bundled GitHub skills stay enabled. They provide task guidance and
the `gh` fallback; disabling a skill does not disable the connector or revoke
its human OAuth credential. Governed harness synchronization carries this
project configuration to every managed repository. Start a new Codex task
after the configuration lands so the updated project layer is loaded.

## Failure modes

- `no app config for "<slug>"`: create `~/.config/<slug>/app-id`; fetch the
  PEM with `ensure-private-key.mjs` (Pass vault **Agent Identities**).
- `pass-cli … failed`: `pass-cli login`, confirm the slug item has
  `private-key.pem`, then `ensure-private-key.mjs <slug> [--force]`.
- Mint fails with a JWT `401`: the `app-id` and key belong to different
  Apps, or the key was revoked — regenerate it.
- `expected exactly one installation`: the App is installed on more than one
  account; set `GH_APP_INSTALLATION_ID` explicitly.
- A `gh` call acts as `qwts` in a bot worktree: run `gh whoami`;
  `GH_TOKEN` unexported or expired — re-mint.
- `agent is outside bot territory`: enter a linked bot worktree; the shim
  refuses stock human `gh` from a primary checkout or non-repo path.
- Stale token helper / `which gh` is Homebrew: re-run `install-gh-shim.mjs`
  from this checkout; expect `~/.local/bin/gh` or `~/.config/agent-bot/bin/gh`.
- `git push` rejected while the token is set: the target repo is not in that
  App's installation list — add it (setup step 3).
- The wrong `[bot]` authored a PR: the launcher exported another harness's
  `GH_AGENT_APP` — fix the launch environment, not the agent.
- A PR appears as `qwts` with the shim installed and working: a **GitHub MCP
  connector** in the harness made it — connectors hold the human's OAuth,
  never an App token, and bypass `git` and `gh` entirely. Confirm the governed
  Codex configuration is loaded and still blocks that connector's destructive
  tools; do not disable the GitHub skills as a substitute.
