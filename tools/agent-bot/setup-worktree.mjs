#!/usr/bin/env node
// One-shot bot-identity setup for the current git worktree (ENG-0016).
// Designed to run from a session-start hook: it exits 0 quietly whenever it
// has nothing to do, and configures nothing outside the worktree it runs in.
//
//   node tools/agent-bot/setup-worktree.mjs [app-slug]     (slug defaults to $GH_AGENT_APP)
//
// What it does, all scoped via extensions.worktreeConfig:
//   - author/committer identity = <slug>[bot] with the bot's noreply email
//   - commit signing off (the human's key would show Unverified on bot commits)
//   - credential helper = git-credential-bot.mjs, so pushes mint on demand
//   - rewrites an SSH origin URL to HTTPS (SSH would push as the human)
//
// Guard: it only touches LINKED worktrees (git-dir != common-dir). A session
// in a primary checkout is left alone, so a human's own clone never silently
// becomes bot-authored.

import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

async function botUid(slug) {
  const cachePath = join(homedir(), '.config', slug, 'bot-uid');
  try {
    return readFileSync(cachePath, 'utf8').trim();
  } catch {
    /* not cached yet */
  }
  const res = await fetch(`https://api.github.com/users/${encodeURIComponent(`${slug}[bot]`)}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'qwts-agent-setup-worktree' },
  });
  if (!res.ok) throw new Error(`could not resolve ${slug}[bot]'s user id (HTTP ${res.status})`);
  const uid = String((await res.json()).id);
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, `${uid}\n`);
  return uid;
}

async function main() {
  const slug = process.argv[2] ?? process.env.GH_AGENT_APP;
  if (!slug) return; // no identity configured for this launcher — nothing to do

  let gitDir; let commonDir;
  try {
    gitDir = git('rev-parse', '--absolute-git-dir');
    commonDir = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  } catch {
    return; // not inside a git repository — nothing to do
  }
  if (gitDir === commonDir) return; // primary checkout, not an agent worktree

  const uid = await botUid(slug);
  const helper = join(dirname(fileURLToPath(import.meta.url)), 'git-credential-bot.mjs');

  git('config', 'extensions.worktreeConfig', 'true');
  git('config', '--worktree', 'user.name', `${slug}[bot]`);
  git('config', '--worktree', 'user.email', `${uid}+${slug}[bot]@users.noreply.github.com`);
  git('config', '--worktree', 'commit.gpgsign', 'false');
  try {
    git('config', '--worktree', '--unset-all', 'credential.helper');
  } catch {
    /* nothing to unset on first run */
  }
  git('config', '--worktree', '--add', 'credential.helper', '');
  git('config', '--worktree', '--add', 'credential.helper', `!node ${helper} ${slug}`);

  try {
    const origin = git('remote', 'get-url', 'origin');
    const sshMatch = origin.match(/^(?:ssh:\/\/)?git@github\.com[:/](.+?)(?:\.git)?$/);
    if (sshMatch) git('remote', 'set-url', 'origin', `https://github.com/${sshMatch[1]}`);
  } catch {
    /* no origin remote — fine */
  }

  process.stdout.write(`worktree configured for ${slug}[bot]\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`setup-worktree: ${err.message}`);
    process.exit(1);
  });
}
