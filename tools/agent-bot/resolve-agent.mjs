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
// Every step is optional and every failure is quiet: no pin, no config, or no
// git at all just falls through to detection, which is what a plain human
// checkout should do.

import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { detectHarness } from './detect-harness.mjs';

export function pinnedSlug(cwd = process.cwd()) {
  try {
    // --get honors worktree config when extensions.worktreeConfig is on, so a
    // per-worktree pin outranks a checkout-wide one without extra work here.
    const value = execFileSync('git', ['config', '--get', 'qwts.agentApp'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return value === '' ? null : value;
  } catch {
    return null; // unset, or not a git directory at all
  }
}

export function resolveAgentSlug({ explicit = null, env = process.env, cwd = process.cwd() } = {}) {
  return explicit ?? env.GH_AGENT_APP ?? pinnedSlug(cwd) ?? detectHarness(env) ?? null;
}
