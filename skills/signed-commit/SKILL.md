---
name: signed-commit
description: Push commits as a bot so GitHub marks them Verified, using the Git Data API instead of git push. Use when committing or pushing from an agent-bot worktree, when a bot's commits show Unverified, when a repo requires signed commits, or when setting up or troubleshooting the bot identity and its token.
---

# Signed commits as a bot

`git commit` in an agent-bot worktree **cannot** produce a Verified commit.
`setup-worktree.mjs` deliberately sets `commit.gpgsign=false`, because signing a
bot's commit with the human's GPG/SSH key shows **Unverified** — the key does
not match the bot's committer email. Bot worktrees have no signing key of their
own (`gpg` is often absent; `git log --format=%G?` prints `N`).

Commits created through the **Git Data API** are signed by GitHub's own key
server-side and show **Verified**. That is the only path to a verified bot
commit, so prefer it whenever a bot is the author.

## Install

Centralized here per ENG-0004 — no per-repo copies. Link it into the harness
once per machine:

```bash
mkdir -p ~/.claude/skills
PLAYBOOK_ROOT="$(playbook-engineering status | sed -n '1p')"
ln -sfn "$PLAYBOOK_ROOT/skills/signed-commit" ~/.claude/skills/signed-commit
```

Symlink rather than copy, so a change here reaches every machine on its next
`git pull` instead of drifting silently.

## Workflow

Work normally — branch, edit, commit locally, run the repo's gates. Then replace
the local commits with signed equivalents just before opening the PR:

```bash
playbook-signed-commit
```

It replays every commit from the merge-base to `HEAD` through
`git/blobs` → `git/trees` → `git/commits`, force-updates the branch ref, and
resets the local branch onto the signed history. Each commit is replayed
individually — messages and boundaries are preserved, not squashed.

Preview without writing anything:

```bash
playbook-signed-commit --dry-run
```

Flags: `--base <ref>`, `--branch <name>`, `--repo owner/name`,
`--allow-default-branch`.

### Order of operations

Sign **before** opening the PR where possible. The ref rewrite is a force-push,
so on an existing PR it re-runs CI and any review comment anchored to an old
commit SHA goes outdated. If the PR already exists, run it anyway and say in the
PR that the force-push changed signatures only. Prove it:

```bash
git diff --stat <old-sha> <new-sha>
```

Empty output means only the signature changed.

## What it refuses to do

Each of these is a silent-corruption risk, so it exits rather than guessing:

- **Dirty working tree** — the signed commit must match what was tested.
- **Tree mismatch** — after building each tree it compares against the local
  commit's tree hash. A mismatch means the signed commit would differ from the
  reviewed and CI-validated one. This assertion is the correctness guarantee:
  a construction bug fails closed instead of publishing wrong content.
- **Unsigned result** — a `verification.verified: false` response stops the run
  rather than leaving a half-rewritten branch.
- **Merge commits** — rebase to linear history first.
- **Submodule changes** — the API path does not handle gitlink entries.
- **The default branch** — unless `--allow-default-branch` is passed.
- **A branch whose remote head your branch does not contain.** Before replay the
  remote ref is read and must be an ancestor of local `HEAD`; it is read again
  before the push to catch anything landing mid-run. Either way nothing is
  written, and the commits already created are left unreferenced.

  The final update *is* a force — replayed commits are not descendants of the
  local ones — so the REST API's missing force-with-lease has to be replaced by
  this check. Comparing the ref before and after replay is **not** sufficient
  alone: it misses a push that landed before the run started, which is the
  likelier case. Recovery is `git fetch && git rebase`, then sign again.

  This matters in practice: several agents work in parallel worktrees against
  the same repositories.

Empty commits are replayed with their parent's tree rather than dropped, so a
branch of `--allow-empty` markers keeps its messages and boundaries.

File modes are preserved, including `100755` and symlinks (`120000`, stored as
the target path rather than followed).

## Identity and tokens

**Usually there is nothing to do.** In a configured bot worktree the `gh` shim
authenticates as that worktree's bot on its own, and the per-worktree credential
helper mints tokens on demand, cached until 5 minutes before expiry. Check
before assuming a problem:

```bash
gh auth status
```

The active account should be the expected `<slug>[bot]`, via `GH_TOKEN`.

### If it needs minting

Only outside a configured worktree, or in CI:

```bash
GH_TOKEN=$(playbook-mint-token) || exit 1
export GH_TOKEN
```

Assignment and export are separate statements on purpose: `export FOO=$(cmd)`
returns `export`'s status (0) even when the mint fails, and `gh` treats an empty
`GH_TOKEN` as absent — silently falling back to the human's stored login. A
failed mint must abort the task, never continue as the human.

### When something is broken

Setup, the worktree hook, the shim, and the full failure-mode list live in
[agent-bot-identity](../../docs/reference/agent-bot-identity.md). Read it there
rather than restating it here (ENG-0006 item 1). The two that bite hardest:

- A PR appears as the human despite a working shim → a **GitHub MCP connector**
  made it. Connectors carry the human's OAuth and bypass `git` and `gh`
  entirely. `git` and `gh` are the only sanctioned write paths.
- An SSH remote authenticates the push with the human's key regardless of
  `GH_TOKEN`. Agent checkouts use **HTTPS remotes**.
