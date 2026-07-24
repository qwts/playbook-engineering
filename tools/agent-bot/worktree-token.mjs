#!/usr/bin/env node
// Print a GH_TOKEN for the bot identity of the CURRENT worktree, or nothing
// when this isn't a bot worktree. Used by the gh shim (install-gh-shim.mjs)
// so API calls made from bot territory authenticate as the bot automatically
// (ENG-0045, decision 2 — agents carry zero conventions).
//
// Exit contract (the shim depends on it):
//   0 + token on stdout  -> bot worktree, token ready
//   0 + empty stdout     -> not a bot worktree; caller proceeds as the human
//   non-zero             -> bot worktree but the mint FAILED; caller must
//                           abort rather than fall back to the human
//
// The worktree's identity is whatever setup-worktree baked into it — the same
// config.worktree that governs commits, so git and gh can never disagree.
// Tokens are cached per worktree inside the private git dir (never in the
// working tree) and reused until 5 minutes before expiry.

import process from 'node:process';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mint } from './mint-token.mjs';

function git(...args) {
  // stdio pipes throughout: execFileSync otherwise passes git's stderr
  // through to the parent, leaking "fatal: not a git repository" noise into
  // every human-context invocation.
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// The credential-helper line baked in by setup-worktree is the territory
// marker: only worktrees it configured ever have one. A pinned identity
// (either config key generation) overrides WHICH bot, but never turns a
// checkout without the helper into bot territory — a stray qwts.agentApp in
// a human clone must not make the shim mint (ENG-0045, decision 3).
export function worktreeSlug(helperLines, pinned) {
  let fromHelper = null;
  for (const line of (helperLines ?? '').split('\n').reverse()) {
    const m = line.match(/git-credential-bot\.mjs\s+(\S+)\s*$/);
    if (m) {
      fromHelper = m[1];
      break;
    }
  }
  if (!fromHelper) return null;
  return pinned || fromHelper;
}

async function main() {
  let gitDir;
  try {
    gitDir = git('rev-parse', '--absolute-git-dir');
  } catch {
    return; // not a repository — human context, print nothing
  }
  let pinned = null;
  for (const key of ['qwts.agentApp', 'agentBot.app']) {
    try {
      pinned = git('config', '--get', key) || null;
      if (pinned) break;
    } catch {
      /* unset */
    }
  }
  let helpers = '';
  try {
    helpers = git('config', '--get-all', 'credential.helper');
  } catch {
    /* none configured */
  }
  const slug = worktreeSlug(helpers, pinned);
  if (!slug) return; // human worktree — print nothing

  const cachePath = join(gitDir, 'agent-bot-token.json');
  try {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (cached.slug === slug && Date.parse(cached.expires_at) - Date.now() > 5 * 60 * 1000) {
      process.stdout.write(`${cached.token}\n`);
      return;
    }
  } catch {
    /* no usable cache */
  }

  const grant = await mint({ slug });
  try {
    writeFileSync(cachePath, `${JSON.stringify({ slug, token: grant.token, expires_at: grant.expires_at })}\n`, {
      mode: 0o600,
    });
  } catch {
    // Best-effort: a linked worktree's git dir lives under the MAIN
    // checkout, which sandboxed harnesses (Codex) may not allow writes to.
    // An uncached mint still succeeds — only a failed MINT may abort.
  }
  process.stdout.write(`${grant.token}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`worktree-token: ${err.message}`);
    process.exit(1);
  });
}
