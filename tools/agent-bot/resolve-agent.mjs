// One resolution order for every consumer that needs to know which agent it is
// (ENG-0079). The harness detects, the pin refines — but only if every path to
// a token asks the same question the same way.
//
// Before this existed, `setup-worktree.mjs` read the pin and the token minters
// did not, so a pinned worktree committed as its pinned agent and then opened
// its PR as the harness. The identity was right where git looked and wrong
// where GitHub looked, which is worse than being consistently wrong: the
// commits and the PR disagree about who did the work.
//
//   explicit --app / argument   — the caller knows exactly what it wants
//   GH_AGENT_APP                — a launcher told this whole process
//   git config qwts.agentApp    — the pin, worktree first, then the checkout
//   detectHarness(env)          — the tool that is running
//
// Each step is optional: no pin and no harness markers just means no identity,
// which is what a plain human checkout should resolve to. What is *not*
// optional is the difference between a pin that is absent and a pin that could
// not be read — see pinnedSlug.

import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { detectHarness } from './detect-harness.mjs';

// Unset and unverifiable are different answers, and only one of them may fall
// through to detection. A malformed config, an ambiguous pin (two values), or
// a config we lack permission to read all mean *the pin could not be checked*
// — and falling back there produces exactly the split identity this module
// exists to prevent: commits authored as the pinned agent, tokens minted for
// the harness. Those fail closed. Only `git config` exit 1, the key genuinely
// not being set, returns null.
export function pinnedSlug(cwd = process.cwd()) {
  try {
    // --get honors worktree config when extensions.worktreeConfig is on, so a
    // per-worktree pin outranks a checkout-wide one without extra work here.
    const value = execFileSync('git', ['config', '--get', 'qwts.agentApp'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return value === '' ? null : value;
  } catch (error) {
    if (error.status === 1) return null; // the ordinary case: no pin here

    if (error.code === 'ENOENT') {
      // A directory that does not exist is the caller's bug; git being absent
      // means no pin mechanism exists on this machine at all, which is an
      // honest null rather than an unreadable pin.
      if (!existsSync(cwd)) throw new Error(`cannot resolve an agent for a directory that does not exist: ${cwd}`);
      return null;
    }

    const detail = (error.stderr ?? '').toString().trim() || `git config exited ${error.status ?? 'abnormally'}`;
    throw new Error(
      `could not read the qwts.agentApp pin in ${cwd}: ${detail}. ` +
        'Refusing to fall back to harness detection — an unverifiable pin is not an absent one.',
    );
  }
}

export function resolveAgentSlug({ explicit = null, env = process.env, cwd = process.cwd() } = {}) {
  return explicit ?? env.GH_AGENT_APP ?? pinnedSlug(cwd) ?? detectHarness(env) ?? null;
}
