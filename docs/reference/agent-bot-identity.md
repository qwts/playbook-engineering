# Agent bot identities — setup and usage

How agents author commits and PRs as their own `[bot]` identity instead of
`qwts`, so the approving human review the
[branch/PR/review SOP](../sop/branch-pr-review.md) requires is possible at all.
Decision and rationale: [ENG-0016](../decisions/ENG-0016-agent-pr-bot-identity.md).

There is **one GitHub App per agent harness**, so authorship in history tells
you which harness produced a change: `qwts-claude-agent`, `qwts-codex-agent`,
`qwts-cursor-agent`, `qwts-vscode-agent`. The examples below use
`qwts-claude-agent`; every step repeats per App.

## One-time setup (human, in the browser — repeat per App)

1. GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.
   - **Name:** the harness slug, e.g. `qwts-claude-agent` — this becomes the
     `[bot]` author name.
   - **Homepage URL:** any real URL; this playbook repo's URL is fine.
   - **Webhook:** uncheck *Active* — no webhook is needed.
   - **Repository permissions:** Contents *Read and write*; Pull requests
     *Read and write*; Issues *Read and write*. Metadata read-only is added
     automatically. Nothing else.
   - **Identifying and authorizing users** and **Post installation:** leave
     every field blank and every box unchecked — that section configures
     user-to-server OAuth, where the App acts *as a signed-in user*. A token
     authorized by `qwts` attributes actions to `qwts`, which recreates the
     self-approval deadlock; the bots only ever use installation tokens.
   - **Where can this GitHub App be installed?** Only on this account.
2. After creating, note the **App ID** shown at the top of the App's page and
   **generate a private key** on the same page. Store both under the App's
   slug, outside every repository:

   ```bash
   mkdir -p ~/.config/qwts-claude-agent && echo '<app id>' > ~/.config/qwts-claude-agent/app-id && mv ~/Downloads/qwts-claude-agent.*.pem ~/.config/qwts-claude-agent/private-key.pem && chmod 600 ~/.config/qwts-claude-agent/private-key.pem
   ```

3. **Install App** (left sidebar) → install on `qwts` → *Only select
   repositories* → the repos this harness works in. Extend the selection when
   a new repo joins; tokens only ever reach the selected list.
4. In each harness's launch environment, name the App it authors as:

   ```bash
   export GH_AGENT_APP=qwts-claude-agent
   ```

5. Once, as the human: `gh auth setup-git`, so git uses `gh` as its
   credential helper (needed for the bot pushes below).

## Per-task usage (agent)

Mint a token — valid one hour, scoped to that App's installed repositories —
and act through it. Minting is a hard gate: assignment and export are two
steps, because `export GH_TOKEN=$(…)` returns `export`'s own status (0) even
when the mint fails, and `gh` treats the resulting empty `GH_TOKEN` as absent
— silently falling back to the stored `qwts` login and recreating the
human-authored PR this runbook exists to prevent.

```bash
GH_TOKEN=$(node tools/agent-bot/mint-token.mjs) || exit 1
export GH_TOKEN
```

A failed mint must abort the task, never continue as `qwts`.

The `tools/agent-bot/` paths here are relative to this repository; in a
worktree of any *other* repo, run the same tools from the canonical checkout,
`~/Code/playbook-engineering/tools/agent-bot/` — they are centralized here per
[ENG-0004](../decisions/ENG-0004-centralize-shared-cicd.md) and need no
per-repo copies.

The tool reads `GH_AGENT_APP` (or an explicit `--app qwts-claude-agent` flag,
or a `GH_APP_ID`/`GH_APP_PRIVATE_KEY_PATH` pair for CI) and finds the App's
credentials under `~/.config/<slug>/`.

- `gh` gives `GH_TOKEN` precedence over the stored `qwts` login, so
  `gh pr create` (and every other call) now acts as the bot. The PR's author
  is whoever *creates* it — this is the step that matters.
- `git push` also authenticates as the bot, because the `gh` credential
  helper honors `GH_TOKEN` (setup step 5).
- Without `GH_TOKEN` set, `gh` and `git` fall back to the stored `qwts`
  login — the human side needs no change.

Attribute the commits to the bot as well, so history matches the PR author,
and disable commit signing — a bot commit signed with the human's GPG/SSH key
shows **Unverified** on GitHub, because the key's identity does not match the
bot's committer email:

```bash
BOT_UID=$(gh api "users/${GH_AGENT_APP}%5Bbot%5D" --jq .id)
export GIT_AUTHOR_NAME="${GH_AGENT_APP}[bot]" GIT_COMMITTER_NAME="${GH_AGENT_APP}[bot]"
export GIT_AUTHOR_EMAIL="${BOT_UID}+${GH_AGENT_APP}[bot]@users.noreply.github.com" GIT_COMMITTER_EMAIL="${BOT_UID}+${GH_AGENT_APP}[bot]@users.noreply.github.com"
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false
```

Agent checkouts must use **HTTPS remotes**. An SSH remote (`git@github.com:…`)
authenticates the push with the human's SSH key regardless of `GH_TOKEN`,
silently making `qwts` the pusher again.

## Automating worktrees (tool-agnostic)

Agents work in linked git worktrees, so the identity rides on the worktree and
is applied by git itself — no per-tool or per-repo setup, and nothing specific
to any one IDE. One machine-wide command enables it:

```bash
git config --global core.hooksPath ~/Code/playbook-engineering/tools/agent-bot/hooks
```

That points every repo's git hooks at this repo's [`hooks/`](../../tools/agent-bot/hooks/).
Its `post-checkout` hook runs on `git worktree add` **regardless of which tool
created the worktree** — Codex, Cursor, VS Code, a plain terminal — and calls
`setup-worktree.mjs`, which:

- **Detects which IDE is running** from the environment that tool sets on its
  own (`CLAUDECODE`, `CODEX_*`, Cursor's bundle id, `TERM_PROGRAM=vscode`; see
  [`detect-harness.mjs`](../../tools/agent-bot/detect-harness.mjs)) and picks
  the matching bot — `qwts-codex-agent` in Codex, `qwts-cursor-agent` in
  Cursor, and so on. Nothing hard-codes one identity across tools.
- Scoped via `extensions.worktreeConfig` so nothing leaks into the primary
  checkout, sets the bot author/committer identity, disables commit signing,
  rewrites an SSH origin to HTTPS, and wires
  `git-credential-bot.mjs` as the credential helper — every later `git push`
  mints its own fresh token, so no `GH_TOKEN` is needed for pushes.

The hook only touches *linked* worktrees (a primary checkout, and a bare human
shell with no IDE markers, are left as the human) and swallows any error so it
never blocks a checkout. It also chains to a repo-local `post-checkout` if one
exists, so the global path never disables another repo's hook. An explicit
`--app <slug>`, `GH_AGENT_APP`, or `git config qwts.agentApp` still overrides
detection when you need to force a specific identity.

Minting `GH_TOKEN` explicitly (previous section) then only matters for API
calls such as `gh pr create` — the step that sets the PR's author — and
`mint-token.mjs` uses the same IDE detection, so it picks the right bot with no
argument.

## Verifying it works

```bash
GH_TOKEN=$(node tools/agent-bot/mint-token.mjs) gh api installation/repositories --jq '.repositories[].full_name'
```

lists exactly the repositories the selected App is installed on. A PR opened
under `GH_TOKEN` shows that App's `[bot]` as its author, and the review dialog
offers **Approve** to `qwts` — the option that never appears when `qwts` is
the author.

## Failure modes

- `no app config for "<slug>"`: setup step 2 was not done for that App —
  create `~/.config/<slug>/app-id` and `private-key.pem`.
- Mint fails with a `401` mentioning the JWT: the `app-id` and the private key
  belong to different Apps, or the key was revoked — regenerate the key.
- `expected exactly one installation`: the App is installed on more than one
  account; set `GH_APP_INSTALLATION_ID` explicitly.
- A `gh` call unexpectedly acts as `qwts`: `GH_TOKEN` is not exported in that
  shell, or the token is older than an hour — re-mint.
- `git push` rejected while the token is set: the target repo is not in that
  App's installation list — add it (setup step 3).
- The wrong `[bot]` authored a PR: the launcher exported another harness's
  `GH_AGENT_APP` — fix the launch environment, not the agent.
