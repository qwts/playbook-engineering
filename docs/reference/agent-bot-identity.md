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
   repositories* → the repos this harness works in. Extend the selection when
   a new repo joins; tokens only ever reach the selected list.
4. Nothing else. Identity is auto-detected per IDE (see
   [Automating worktrees](#automating-worktrees-tool-agnostic));
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

The tool reads `GH_AGENT_APP` (or `--app <slug>`, or a
`GH_APP_ID`/`GH_APP_PRIVATE_KEY_PATH` pair for CI) and finds credentials
under `~/.config/<slug>/`.

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

## Automating worktrees (tool-agnostic)

Agents work in linked git worktrees, so the identity rides on the worktree and
is applied by git itself — no per-tool or per-repo setup. One machine-wide
command enables it:

```bash
git config --global core.hooksPath ~/Code/playbook-engineering/tools/agent-bot/hooks
```

That points every repo's git hooks at this repo's [`hooks/`](../../tools/agent-bot/hooks/).
Its `post-checkout` hook runs on `git worktree add` **regardless of which tool
created the worktree** and calls `setup-worktree.mjs`, which:

- **Detects which IDE is running** from the environment that tool sets on its
  own (`CLAUDECODE`, `CODEX_*`, Cursor's bundle id, `TERM_PROGRAM=vscode`; see
  [`detect-harness.mjs`](../../tools/agent-bot/detect-harness.mjs)) and picks
  the matching bot. Nothing hard-codes one identity across tools.
- Scoped via `extensions.worktreeConfig` so nothing leaks into the primary
  checkout, sets the bot author/committer identity, disables commit signing,
  rewrites an SSH origin to HTTPS, and wires
  `git-credential-bot.mjs` as the credential helper — every later `git push`
  mints its own fresh token, so no `GH_TOKEN` is needed for pushes.

The hook only touches *linked* worktrees (primary checkouts, and human shells
with no IDE markers, stay the human's) and swallows errors so it never blocks
a checkout. It chains to a repo-local `post-checkout` if one exists. An
explicit `--app <slug>`, `GH_AGENT_APP`, or `git config qwts.agentApp`
overrides detection.

**Where the git-hook trigger cannot fire.** A repo with its own repo-local
`core.hooksPath` (husky: `.husky/_`) shadows the global path — and `.husky/_`
is generated by `npm install`, absent in a fresh worktree, so `git worktree
add` there runs **no hook at all** and the agent commits as `qwts`. Remedy:
run `node tools/agent-bot/setup-worktree.mjs <app-slug>` once in the
worktree — idempotent, touching only linked worktrees. No per-harness
session machinery: under
[ENG-0045](../decisions/ENG-0045-agent-environments-are-bot-territory.md)
the model carries zero tool-specific mechanisms, and its `pre-commit` guard
turns a missed hook into a loud error instead of a silent `qwts` commit.

**Agents do not work in primary checkouts.** Per
[ENG-0045](../decisions/ENG-0045-agent-environments-are-bot-territory.md),
agent territory is `~/.<tool>/worktrees/` — the directory dictates the App —
and primary clones are the human's, stock; a clone is never "pinned" to a bot
identity. The machine-wide `pre-commit` guard enforces the agent side of the
boundary: an agent-marked process attempting a human-attributed commit in a
GitHub-remoted repo is blocked with the notice that agents may only commit
within `~/.<tool>/worktrees/<repo>`.

`mint-token.mjs` uses the same IDE detection, so the manual mint (per-task
section) picks the right bot with no argument.

## The gh shim (PRs and comments as the bot, automatically)

`gh` never reads git config — it uses its stored human login or `GH_TOKEN` —
so without help, a perfectly configured bot worktree still opens PRs as
`qwts`. The shim closes that lane. One machine-wide install:

```bash
node tools/agent-bot/install-gh-shim.mjs
```

It writes `~/.config/agent-bot/bin/gh` and an idempotent PATH line to
`~/.zshenv`. Outside bot territory, or with `GH_TOKEN` already set, it is a
pure passthrough — the human's `gh` never changes. Bot territory is the
worktree's directory first (`~/.<tool>/worktrees/**`, ENG-0045 decision 1 —
holds even when a sandbox blocked the worktree config from landing), else the
credential helper `setup-worktree.mjs` writes; a stray `qwts.agentApp` pin in
a normal clone never makes the shim mint. Inside a bot worktree it mints a
token, caches it in the private git dir (best-effort), and exports it. **If the mint fails it aborts** — it never falls back to the
human. Processes that never read `~/.zshenv` keep stock `gh` (fail-open); the
[ENG-0045](../decisions/ENG-0045-agent-environments-are-bot-territory.md)
review-requirement backstop covers that residue. `gh whoami` answers plainly
who `gh` acts as here — the bot slug in territory, your login outside
(`gh api user` instead *errors* for bots: no `/user` on installation tokens).

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
- `git push` rejected while the token is set: the target repo is not in that
  App's installation list — add it (setup step 3).
- The wrong `[bot]` authored a PR: the launcher exported another harness's
  `GH_AGENT_APP` — fix the launch environment, not the agent.
- A PR appears as `qwts` with the shim installed and working: a **GitHub MCP
  connector** in the harness made it — connectors hold the human's OAuth,
  never an App token, and bypass `git` and `gh` entirely. Disconnect the
  GitHub connector in every agent harness (or deny its write tools); git and
  `gh` are the only sanctioned write paths to GitHub.
