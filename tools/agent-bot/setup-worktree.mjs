#!/usr/bin/env node
// One-shot bot-identity setup for the current git worktree (ENG-0016).
// Harness-agnostic: git's post-checkout hook invokes it regardless of which
// tool created the worktree. Provider transcript adapters are inputs to the
// vendor-neutral execution-identity contract. Exits 0 quietly whenever it has
// nothing to do, and configures nothing outside the worktree it runs in.
//
//   node tools/agent-bot/setup-worktree.mjs [app-slug]
//
// Slug resolution, first hit wins: explicit arg, then $GH_AGENT_APP, then the
// git config value `qwts.agentApp`. The resolved App is persisted as the
// worktree pin, so later token minters and the gh shim cannot fall back to a
// different harness identity:
//
//   git config qwts.agentApp qwts-codex-agent      (per checkout)
//   git config --global qwts.agentApp qwts-...      (machine default)
//
// Resolution itself lives in resolve-agent.mjs, shared with the token minters
// so a pinned worktree commits and pushes as the same agent (ENG-0079).
//
// What it does, all scoped via extensions.worktreeConfig:
//   - author/committer identity = <slug>[bot] with the bot's noreply email
//   - commit signing off (the human's key would show Unverified on bot commits)
//   - credential helper = git-credential-bot.mjs, so pushes mint on demand
//   - rewrites an SSH origin URL to HTTPS (SSH would push as the human)
//   - if ~/.config/<slug>/private-key.pem is missing, fetch it from Proton Pass
//     (vault "Agent Identities", item title = slug) via pass-cli
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
import { resolveAgentSlug } from './resolve-agent.mjs';
import {
  discoverTranscript,
  ensureAgentIdentity,
  harnessForApp,
  identityFieldsFromEnv,
  stateDirectory,
} from './agent-identity.mjs';
import { ensurePrivateKey } from './ensure-private-key.mjs';

function git(...args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function validateAppSlug(slug) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(slug)) {
    throw new Error(`invalid GitHub App slug: ${JSON.stringify(slug)}`);
  }
  return slug;
}

export function credentialHelperCommand(helper, slug) {
  // Git executes ! helpers through a POSIX shell, including under Git Bash.
  // fileURLToPath returns backslashes on Windows; the shell consumes those as
  // escapes unless the path is normalized and quoted.
  const shellPath = normalizeGitBashPath(helper).replaceAll("'", "'\"'\"'");
  return `!node '${shellPath}' ${validateAppSlug(slug)}`;
}

export function normalizeGitBashPath(value) {
  return value.replaceAll('\\', '/');
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
  // Explicit override wins; otherwise detect the IDE from its own environment
  // so the bot matches the tool with no per-tool setup.
  const resolvedSlug = resolveAgentSlug({ explicit: process.argv[2] });
  if (!resolvedSlug) return; // no identity resolved for this checkout — nothing to do

  let gitDir; let commonDir;
  try {
    gitDir = git('rev-parse', '--absolute-git-dir');
    commonDir = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  } catch {
    return; // not inside a git repository — nothing to do
  }
  if (gitDir === commonDir) return; // primary checkout, not an agent worktree

  const slug = validateAppSlug(resolvedSlug);
  const key = ensurePrivateKey({ slug });
  if (key.downloaded) {
    process.stdout.write(`private key fetched from Proton Pass for ${slug}\n`);
  }
  const uid = await botUid(slug);
  const agentBotDir = dirname(fileURLToPath(import.meta.url));
  const helper = join(agentBotDir, 'git-credential-bot.mjs');
  const hooks = normalizeGitBashPath(join(agentBotDir, 'hooks'));
  let previousHooks = null;
  try {
    previousHooks = normalizeGitBashPath(git('config', '--path', '--get', 'core.hooksPath')) || null;
  } catch {
    /* no hooks path was configured */
  }

  git('config', 'extensions.worktreeConfig', 'true');
  let currentAgentId = null;
  try {
    currentAgentId = git('config', '--worktree', '--get', 'qwts.agentId') || null;
  } catch {
    /* first conversation in this worktree */
  }
  const executionIdentity = ensureAgentIdentity({
    currentId: currentAgentId,
    appSlug: slug,
    botUid: uid,
    harness: harnessForApp(slug),
    transcript: discoverTranscript(),
    fields: identityFieldsFromEnv(),
    stateDir: stateDirectory(),
  });
  git('config', '--worktree', 'qwts.agentApp', slug);
  git('config', '--worktree', 'qwts.agentId', executionIdentity.id);
  git('config', '--worktree', 'user.name', `${slug}[bot]`);
  git('config', '--worktree', 'user.email', `${uid}+${slug}[bot]@users.noreply.github.com`);
  git('config', '--worktree', 'commit.gpgsign', 'false');
  if (previousHooks && previousHooks !== hooks) {
    git('config', '--worktree', 'qwts.chainedHooksPath', previousHooks);
  }
  git('config', '--worktree', 'core.hooksPath', hooks);
  try {
    git('config', '--worktree', '--unset-all', 'credential.helper');
  } catch {
    /* nothing to unset on first run */
  }
  git('config', '--worktree', '--add', 'credential.helper', '');
  git('config', '--worktree', '--add', 'credential.helper', credentialHelperCommand(helper, slug));

  try {
    const origin = git('remote', 'get-url', 'origin');
    const sshMatch = origin.match(/^(?:ssh:\/\/)?git@github\.com[:/](.+?)(?:\.git)?$/);
    if (sshMatch) git('remote', 'set-url', 'origin', `https://github.com/${sshMatch[1]}`);
  } catch {
    /* no origin remote — fine */
  }

  const transcriptState = executionIdentity.transcript ? 'transcript bound' : 'transcript pending';
  process.stdout.write(
    `worktree configured for ${slug}[bot] as ${executionIdentity.id} (${transcriptState})\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`setup-worktree: ${err.message}`);
    process.exit(1);
  });
}
