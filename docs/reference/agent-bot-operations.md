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
   key** there. Store both under the App's slug, outside every repository:

   ```bash
   mkdir -p ~/.config/qwts-claude-agent && echo '<app id>' > ~/.config/qwts-claude-agent/app-id && mv ~/Downloads/qwts-claude-agent.*.pem ~/.config/qwts-claude-agent/private-key.pem && chmod 600 ~/.config/qwts-claude-agent/private-key.pem
   ```

3. **Install App** (left sidebar) → install on `qwts` → *Only select
   repositories* → **every active and onboarding repo in the manifest** —
   what drift verifies; a subset fails there. Extend it as repos join; tokens
   only ever reach the selected list.
4. **Register it** in [`governance/agents.json`](../../governance/agents.json)
   (slug, harness, `status: active`). Until that lands, drift does not verify
   the App is installed anywhere, and the first symptom of a missed install is
   a push failing mid-task on a repo nobody added.
5. Nothing else. Identity is auto-detected per IDE (see
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
*other* repo, run them from `~/Code/playbook-engineering/tools/agent-bot/` —
centralized per [ENG-0004](../decisions/ENG-0004-centralize-shared-cicd.md),
no per-repo copies.

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

It writes `~/.config/agent-bot/bin/gh` and prepends its directory from
`~/.zshenv`. Outside bot territory, human shells pass through; agent processes
abort before stock `gh` can use the human credential. Territory: any
`.<tool>/worktrees/**` path, else a configured relocation root
(`AGENT_WORKTREE_ROOT`, desktop preference), else the credential helper. Inside, the shim mints and
exports the worktree's bot token. A supplied `GH_TOKEN` must resolve to that bot, and a failed mint
aborts. Processes that never read `~/.zshenv` keep stock `gh`; the
[ENG-0045](../decisions/ENG-0045-agent-environments-are-bot-territory.md)
review requirement remains the backstop. `gh whoami` reports the supplied
token's viewer, the territory bot, or the human login.

## Verifying it works

```bash
GH_TOKEN=$(node tools/agent-bot/mint-token.mjs) gh api installation/repositories --paginate --jq '.repositories[].full_name'
```

lists exactly the repositories the selected App is installed on. `--paginate`
is load-bearing: without it only the first 30 repositories return, and a repo
missing from that page reads as "not covered" — the verification lies. A PR
opened under `GH_TOKEN` shows the App's `[bot]` as author, and the review
dialog offers `qwts` **Approve** — never offered when `qwts` authored it.

## Failure modes

- `no app config for "<slug>"`: setup step 2 was not done for that App —
  create `~/.config/<slug>/app-id` and `private-key.pem`.
- Mint fails with a JWT `401`: the `app-id` and key belong to different
  Apps, or the key was revoked — regenerate it.
- `expected exactly one installation`: the App is installed on more than one
  account; set `GH_APP_INSTALLATION_ID` explicitly.
- A `gh` call acts as `qwts` in a bot worktree: run `gh whoami`;
  `GH_TOKEN` unexported or expired — re-mint.
- `agent is outside bot territory`: enter a linked bot worktree; the shim
  refuses stock human `gh` from a primary checkout or non-repo path.
- `git push` rejected while the token is set: the target repo is not in that
  App's installation list — add it (setup step 3).
- The wrong `[bot]` authored a PR: the launcher exported another harness's
  `GH_AGENT_APP` — fix the launch environment, not the agent.
- A PR appears as `qwts` with the shim installed and working: a **GitHub MCP
  connector** in the harness made it — connectors hold the human's OAuth,
  never an App token, and bypass `git` and `gh` entirely. Disconnect the
  GitHub connector in every agent harness (or deny its write tools); git and
  `gh` are the only sanctioned write paths to GitHub.
