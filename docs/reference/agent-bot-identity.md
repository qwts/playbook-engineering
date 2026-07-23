# Agent bot identity — setup and usage

How agents author commits and PRs as `qwts-agent[bot]` instead of `qwts`, so
the approving human review the [branch/PR/review SOP](../sop/branch-pr-review.md)
requires is possible at all. Decision and rationale:
[ENG-0011](../decisions/ENG-0011-agent-pr-bot-identity.md). The examples below
use `qwts-agent` as the App slug; GitHub App names are globally unique, so
substitute the name the App was actually registered under.

## One-time setup (human, in the browser)

1. GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.
   - **Name:** `qwts-agent` — this becomes the `[bot]` author name.
   - **Homepage URL:** any real URL; this playbook repo's URL is fine.
   - **Webhook:** uncheck *Active* — no webhook is needed.
   - **Repository permissions:** Contents *Read and write*; Pull requests
     *Read and write*; Issues *Read and write*. Metadata read-only is added
     automatically. Nothing else.
   - **Identifying and authorizing users** and **Post installation:** leave
     every field blank and every box unchecked — that section configures
     user-to-server OAuth, where the App acts *as a signed-in user*. A token
     authorized by `qwts` attributes actions to `qwts`, which recreates the
     self-approval deadlock; the bot only ever uses installation tokens.
   - **Where can this GitHub App be installed?** Only on this account.
2. After creating, note the **App ID** shown at the top of the App's page.
3. **Generate a private key** on the same page. Move the downloaded `.pem`
   out of any repository and lock it down:

   ```bash
   mkdir -p ~/.config/qwts-agent && mv ~/Downloads/qwts-agent.*.private-key.pem ~/.config/qwts-agent/private-key.pem && chmod 600 ~/.config/qwts-agent/private-key.pem
   ```

4. **Install App** (left sidebar) → install on `qwts` → *Only select
   repositories* → the repos agents work in. Extend the selection when a new
   repo joins; tokens only ever reach the selected list.
5. Export the two variables agents read, in the shell profile or in whatever
   environment launches agent sessions:

   ```bash
   export GH_APP_ID=<app id>
   export GH_APP_PRIVATE_KEY_PATH=~/.config/qwts-agent/private-key.pem
   ```

6. Once, as the human: `gh auth setup-git`, so git uses `gh` as its
   credential helper (needed for the bot pushes below).

## Per-task usage (agent)

Mint a token — valid one hour, scoped to the installed repositories — and act
through it:

```bash
export GH_TOKEN=$(node tools/agent-bot/mint-token.mjs)
```

- `gh` gives `GH_TOKEN` precedence over the stored `qwts` login, so
  `gh pr create` (and every other call) now acts as the bot. The PR's author
  is whoever *creates* it — this is the step that matters.
- `git push` also authenticates as the bot, because the `gh` credential
  helper honors `GH_TOKEN` (setup step 6).
- Without `GH_TOKEN` set, `gh` and `git` fall back to the stored `qwts`
  login — the human side needs no change.

Attribute the commits to the bot as well, so history matches the PR author:

```bash
BOT_UID=$(gh api 'users/qwts-agent%5Bbot%5D' --jq .id)
export GIT_AUTHOR_NAME='qwts-agent[bot]' GIT_COMMITTER_NAME='qwts-agent[bot]'
export GIT_AUTHOR_EMAIL="${BOT_UID}+qwts-agent[bot]@users.noreply.github.com" GIT_COMMITTER_EMAIL="${BOT_UID}+qwts-agent[bot]@users.noreply.github.com"
```

## Verifying it works

```bash
GH_TOKEN=$(node tools/agent-bot/mint-token.mjs) gh api installation/repositories --jq '.repositories[].full_name'
```

lists exactly the repositories the App is installed on. A PR opened under
`GH_TOKEN` shows `qwts-agent[bot]` as its author, and the review dialog offers
**Approve** to `qwts` — the option that never appears when `qwts` is the
author.

## Failure modes

- Mint fails with a `401` mentioning the JWT: `GH_APP_ID` and the private key
  belong to different Apps, or the key was revoked — regenerate the key.
- `expected exactly one installation`: the App is installed on more than one
  account; set `GH_APP_INSTALLATION_ID` explicitly.
- A `gh` call unexpectedly acts as `qwts`: `GH_TOKEN` is not exported in that
  shell, or the token is older than an hour — re-mint.
- `git push` rejected while the token is set: the target repo is not in the
  App's installation list — add it (setup step 4).
