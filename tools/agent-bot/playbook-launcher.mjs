#!/usr/bin/env node

import process from 'node:process';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync,
  realpathSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REMOTE = /(?:^|[/:])qwts\/playbook-engineering(?:\.git)?$/;
const APPROVED = new Set([
  'tools/agent-bot/agent-identity.mjs',
  'tools/agent-bot/claude-worktree-create',
  'tools/agent-bot/ensure-private-key.mjs',
  'tools/agent-bot/git-credential-bot.mjs',
  'tools/agent-bot/install-gh-shim.mjs',
  'tools/agent-bot/install-hooks.mjs',
  'tools/agent-bot/mint-token.mjs',
  'tools/agent-bot/setup-worktree.mjs',
  'tools/agent-bot/worktree-token.mjs',
  'skills/signed-commit/scripts/signed-commit.mjs',
]);

for (const hook of [
  'applypatch-msg', 'commit-msg', 'fsmonitor-watchman', 'p4-changelist',
  'p4-post-changelist', 'p4-pre-submit', 'p4-prepare-changelist', 'post-applypatch',
  'post-checkout', 'post-commit', 'post-index-change', 'post-merge', 'post-rewrite',
  'pre-applypatch', 'pre-auto-gc', 'pre-commit', 'pre-merge-commit', 'pre-push',
  'pre-rebase', 'prepare-commit-msg', 'reference-transaction', 'sendemail-validate',
]) APPROVED.add(`tools/agent-bot/hooks/${hook}`);

export function configPaths(home = homedir()) {
  const config = join(home, '.config', 'playbook-engineering');
  return { config, selected: join(config, 'selected.json'), registry: join(config, 'repos.json') };
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function inspectCheckout(input) {
  let root;
  try { root = realpathSync(input); } catch { return null; }
  try {
    const top = realpathSync(git(root, ['rev-parse', '--show-toplevel']));
    const remote = git(top, ['remote', 'get-url', 'origin']);
    if (!REMOTE.test(remote)) return null;
    return {
      path: top,
      sha: git(top, ['rev-parse', 'HEAD']),
      branch: git(top, ['branch', '--show-current']) || '(detached)',
      clean: git(top, ['status', '--porcelain', '--untracked-files=normal']) === '',
    };
  } catch { return null; }
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function selectCheckout(input, { home = homedir() } = {}) {
  const info = inspectCheckout(resolve(input));
  if (!info) throw new Error(`${input} is not a qwts/playbook-engineering checkout`);
  if (!info.clean) throw new Error(`${info.path} has uncommitted changes; refusing to pin mutable code`);
  const paths = configPaths(home);
  writeJson(paths.selected, { path: info.path, sha: info.sha });
  const registry = readJson(paths.registry, []).filter((item) => item.path !== info.path);
  writeJson(paths.registry, [{ path: info.path }, ...registry]);
  return info;
}

export function validateSelection({ home = homedir() } = {}) {
  const record = readJson(configPaths(home).selected, null);
  if (!record?.path || !/^[0-9a-f]{40}$/.test(record.sha || '')) return { error: 'no checkout is selected' };
  const info = inspectCheckout(record.path);
  if (!info) return { error: `selected checkout is unavailable: ${record.path}`, record };
  if (!info.clean) return { error: `selected checkout is dirty: ${info.path}`, record, info };
  if (info.sha !== record.sha) return { error: `selected checkout moved from ${record.sha} to ${info.sha}`, record, info };
  try { git(info.path, ['cat-file', '-e', `${record.sha}^{commit}`]); } catch {
    return { error: `pinned commit is unavailable: ${record.sha}`, record, info };
  }
  return { record, info };
}

function walk(root, depth, found) {
  if (depth < 0 || !existsSync(root)) return;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  if (entries.some((entry) => entry.name === '.git')) {
    const info = inspectCheckout(root);
    if (info) found.set(info.path, info);
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.git' || entry.name === 'node_modules') continue;
    walk(join(root, entry.name), depth - 1, found);
  }
}

export function discoverCheckouts({ home = homedir(), roots, depth = 6 } = {}) {
  const paths = configPaths(home);
  const found = new Map();
  for (const item of readJson(paths.registry, [])) {
    const info = inspectCheckout(item.path);
    if (info) found.set(info.path, info);
  }
  const scanRoots = roots || [home, '/Volumes'];
  for (const root of scanRoots) walk(root, depth, found);
  const values = [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
  writeJson(paths.registry, values.map(({ path }) => ({ path })));
  return values;
}

export function approvedEntrypoint(value) {
  if (!value || isAbsolute(value)) return false;
  const clean = normalize(value).replaceAll('\\', '/');
  return clean === value && !clean.startsWith('../') && APPROVED.has(clean);
}

function launcherRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function shimBody(entrypoint) {
  return `#!/bin/sh\nexec "\${HOME}/.local/bin/playbook-engineering" run ${entrypoint} -- "$@"\n`;
}

export function installLauncher({ home = homedir(), root = launcherRoot() } = {}) {
  const info = selectCheckout(root, { home });
  const bin = join(home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  const launcher = join(bin, 'playbook-engineering');
  copyFileSync(fileURLToPath(import.meta.url), launcher);
  chmodSync(launcher, 0o755);
  const shims = {
    'playbook-setup-worktree': 'tools/agent-bot/setup-worktree.mjs',
    'playbook-mint-token': 'tools/agent-bot/mint-token.mjs',
    'playbook-signed-commit': 'skills/signed-commit/scripts/signed-commit.mjs',
    'playbook-claude-worktree-create': 'tools/agent-bot/claude-worktree-create',
    'playbook-git-credential-bot': 'tools/agent-bot/git-credential-bot.mjs',
    'playbook-ensure-private-key': 'tools/agent-bot/ensure-private-key.mjs',
    'playbook-install-hooks': 'tools/agent-bot/install-hooks.mjs',
    'playbook-install-gh-shim': 'tools/agent-bot/install-gh-shim.mjs',
    'playbook-agent-identity': 'tools/agent-bot/agent-identity.mjs',
  };
  for (const [name, entrypoint] of Object.entries(shims)) {
    const path = join(bin, name);
    writeFileSync(path, shimBody(entrypoint), { mode: 0o755 });
  }
  return { ...info, launcher, shims: Object.keys(shims) };
}

function printCandidates(candidates) {
  if (!candidates.length) {
    console.error('playbook-engineering: no qwts/playbook-engineering clones found; clone the repository, then run playbook-engineering select <path>');
    return;
  }
  console.error('Available playbook-engineering checkouts:');
  candidates.forEach((item, index) => console.error(`${index + 1}. ${item.path}  ${item.branch}  ${item.sha}  ${item.clean ? 'clean' : 'dirty'}`));
}

function recover(home) {
  const roots = process.env.PLAYBOOK_SEARCH_ROOTS?.split(':').filter(Boolean);
  const candidates = discoverCheckouts({ home, roots });
  printCandidates(candidates);
  if (!candidates.length) process.exit(1);
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    console.error('Run: playbook-engineering select <path>');
    process.exit(1);
  }
  process.stderr.write('Choose a checkout number: ');
  const answer = readFileSync(0, 'utf8').trim();
  const choice = candidates[Number(answer) - 1];
  if (!choice) throw new Error('invalid checkout selection');
  return selectCheckout(choice.path, { home });
}

function runPinned(entrypoint, args, home) {
  if (!approvedEntrypoint(entrypoint)) throw new Error(`entrypoint is not approved: ${entrypoint || '(missing)'}`);
  let selected = validateSelection({ home });
  if (selected.error) {
    console.error(`playbook-engineering: ${selected.error}`);
    recover(home);
    selected = validateSelection({ home });
  }
  const target = join(selected.info.path, entrypoint);
  if (!existsSync(target)) throw new Error(`pinned entrypoint is missing: ${entrypoint}`);
  const command = entrypoint.endsWith('.mjs') ? process.execPath : target;
  const commandArgs = entrypoint.endsWith('.mjs') ? [target, ...args] : args;
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

function main() {
  const home = homedir();
  const [command, ...args] = process.argv.slice(2);
  if (command === 'install') {
    const info = installLauncher({ home, root: args[0] || process.cwd() });
    console.log(`playbook-engineering pinned ${info.path} at ${info.sha}`);
  } else if (command === 'select') {
    if (!args[0]) recover(home);
    else {
      const info = selectCheckout(args[0], { home });
      console.log(`playbook-engineering pinned ${info.path} at ${info.sha}`);
    }
  } else if (command === 'status') {
    const result = validateSelection({ home });
    if (result.error) throw new Error(result.error);
    console.log(`${result.info.path}\n${result.record.sha}`);
  } else if (command === 'run') {
    const separator = args.indexOf('--');
    const toolArgs = separator === -1 ? args.slice(1) : args.slice(separator + 1);
    runPinned(args[0], toolArgs, home);
  } else {
    throw new Error('usage: playbook-engineering <install|select|status|run>');
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { main(); } catch (error) {
    console.error(`playbook-engineering: ${error.message}`);
    process.exit(1);
  }
}
