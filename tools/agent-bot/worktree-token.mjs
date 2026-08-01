#!/usr/bin/env node
// Print a GH_TOKEN for the bot identity of the CURRENT worktree, or nothing
// when this isn't a bot worktree. Used by the gh shim (install-gh-shim.mjs)
// so API calls made from bot territory authenticate as the bot automatically
// (ENG-0045, decision 2 — agents carry zero conventions).
//
// Exit contract (the shim depends on it):
//   0 + token on stdout  -> bot worktree, token ready
//   0 + empty stdout     -> not a bot worktree; the shim separately decides
//                           whether this is a human shell or a blocked agent
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
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { desktopConfigPath, worktreeRoot } from './claude-worktree-create.mjs';
import { mint } from './mint-token.mjs';
import { detectAgentHarness, HARNESSES } from './detect-harness.mjs';

function git(...args) {
  // stdio pipes throughout: execFileSync otherwise passes git's stderr
  // through to the parent, leaking "fatal: not a git repository" noise into
  // every human-context invocation.
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// ENG-0045 decision 1: the directory dictates the App. A `.<tool>/worktrees/**`
// path belongs to that tool's bot regardless of which process created it — and
// regardless of whether the worktree config ever landed: sandboxed harnesses
// (Codex) can be unable to write the shared git dir at setup time, and an
// unconfigured bot worktree must still resolve as the bot, never the human.
//
// The `.<tool>/worktrees` segment is the signal; the root above it is not.
// A workstation whose boot volume is too small keeps agent worktrees on
// `/Volumes/<drive>/.claude/worktrees` — a fact about the hardware, never a
// statement about who owns the work. Anchoring this to $HOME silently demoted
// every worktree on such a machine to human territory, where the shim then
// refused to run at all and agents fell back to the human's credentials: the
// precise failure ENG-0045 exists to prevent. Accepted tradeoff: a checkout
// that itself contains a literal `.<tool>/worktrees/` path reads as territory.
export function pathSlug(toplevel) {
  if (!toplevel) return null;
  const m = toplevel.match(/(?:^|\/)\.([a-z]+)\/worktrees\//);
  if (!m) return null;
  return HARNESSES.find((h) => h.slug.split('-')[1] === m[1])?.slug ?? null;
}

// A relocation root need not contain the segment: `AGENT_WORKTREE_ROOT` and the
// desktop app's own preference take any directory, and both creators then build
// `<root>/<repo>/<name>`. Those worktrees are Claude's by configuration even
// though the path never says so, and the path rule is precisely the fallback for
// when setup-worktree could not persist the credential helper — so resolution
// reads the same roots the creator does (PR #111 review).
//
// A root of `/` or the home directory itself would make every human checkout
// territory, so those are refused: a preference that broad is a misconfiguration,
// not a claim on the human's clones (decision 3).
export function configuredRootSlug(toplevel, root, home) {
  if (!toplevel || !root || root === '/' || root === home) return null;
  if (toplevel !== root && !toplevel.startsWith(`${root}/`)) return null;
  return 'qwts-claude-agent';
}

// The credential-helper line baked in by setup-worktree marks territory the
// path rule cannot see (an explicitly configured worktree elsewhere).
export function helperSlug(helperLines) {
  for (const line of (helperLines ?? '').split('\n').reverse()) {
    const m = line.match(/(?:git-credential-bot\.mjs|playbook-git-credential-bot)'?\s+(\S+)\s*$/);
    if (m) return m[1];
  }
  return null;
}

// Resolution order: an explicit pin overrides WHICH bot but only inside
// territory; the directory is the primary territory signal (decision 1); the
// helper line covers configured worktrees outside the directory pattern. A
// stray qwts.agentApp in a normal clone still never makes the shim mint
// (decision 3) — a pin alone is not territory.
export function resolveSlug({ pinned, toplevel, helperLines, configuredRoot = null, home = null }) {
  const territory = pathSlug(toplevel) ?? configuredRootSlug(toplevel, configuredRoot, home) ?? helperSlug(helperLines);
  if (!territory) return null;
  return pinned || territory;
}

// Back-compat name used by the gh shim's earlier tests.
export function worktreeSlug(helperLines, pinned) {
  return resolveSlug({ pinned, toplevel: null, home: null, helperLines });
}

async function main() {
  // Agent-process detection is intentionally independent of the current
  // repository. The gh shim uses it to fail closed before a stock human
  // credential can be exercised from a primary checkout or non-repo path.
  if (process.argv.includes('--agent-slug')) {
    const agentSlug = detectAgentHarness(process.env);
    if (agentSlug) process.stdout.write(`${agentSlug}\n`);
    return;
  }

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
  let toplevel = null;
  try {
    toplevel = git('rev-parse', '--show-toplevel');
  } catch {
    /* bare or odd repo — path rule cannot apply */
  }
  // Same roots the creator honors, read the same way — an unreadable or absent
  // desktop config just leaves the path and helper rules to decide.
  let configuredRoot = null;
  try {
    let desktopConfig = null;
    try {
      desktopConfig = readFileSync(desktopConfigPath(), 'utf8');
    } catch {
      /* no desktop config on this machine */
    }
    configuredRoot = worktreeRoot({ desktopConfig });
  } catch {
    /* a malformed preference must never break identity resolution */
  }
  const slug = resolveSlug({ pinned, toplevel, helperLines: helpers, configuredRoot, home: homedir() });
  // --slug: identity only, no mint, no network — the gh shim's `whoami`.
  if (process.argv.includes('--slug')) {
    if (slug) process.stdout.write(`${slug}\n`);
    return;
  }
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
