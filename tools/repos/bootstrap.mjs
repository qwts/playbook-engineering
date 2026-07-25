#!/usr/bin/env node

// bootstrap — clone and safely refresh the local governed-repository fleet.
//
// The manifest remains the source of truth. Active and onboarding repositories
// are cloned when absent; existing clones fetch/prune origin, prune stale
// worktree metadata, and fast-forward main. The command never resets, cleans,
// stashes, deletes a worktree, or rewrites an ahead/divergent branch.
//
// Usage:
//   node tools/repos/bootstrap.mjs
//       [--code-dir <dir>] [--manifest <file>] [--repo <name> ...]

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadManifest, validateManifest } from './lib/manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INCLUDED_STATUSES = new Set(['active', 'onboarding']);

function expandHome(value, home = homedir()) {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

export function parseArgs(argv, { home = homedir() } = {}) {
  const args = {
    codeDir: path.join(home, 'Code'),
    manifest: path.join(ROOT, 'governance', 'repos.json'),
    repos: [],
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--code-dir': {
        const value = argv[++i];
        if (!value) throw new Error('--code-dir requires a directory');
        args.codeDir = path.resolve(expandHome(value, home));
        break;
      }
      case '--manifest': {
        const value = argv[++i];
        if (!value) throw new Error('--manifest requires a file');
        args.manifest = path.resolve(value);
        break;
      }
      case '--repo': {
        const value = argv[++i];
        if (!value) throw new Error('--repo requires a repository name');
        args.repos.push(value);
        break;
      }
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${argv[i]}`);
    }
  }

  return args;
}

export function parseWorktrees(source) {
  return source
    .trim()
    .split(/\n\n+/)
    .filter(Boolean)
    .map((block) => {
      const entry = {};
      for (const line of block.split('\n')) {
        const space = line.indexOf(' ');
        const key = space === -1 ? line : line.slice(0, space);
        const value = space === -1 ? true : line.slice(space + 1);
        entry[key] = value;
      }
      return entry;
    });
}

export function githubRepository(remote) {
  const value = remote.trim();
  let pathname;

  const scp = value.match(/^git@github\.com:(.+)$/i);
  if (scp) {
    pathname = scp[1];
  } else {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    if (parsed.hostname.toLowerCase() !== 'github.com') return null;
    pathname = parsed.pathname;
  }

  const parts = pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
  if (parts.length !== 2 || parts.some((part) => !part)) return null;
  return `${parts[0]}/${parts[1]}`.toLowerCase();
}

function commandError(args, result) {
  const detail = (result.stderr || result.stdout || '').trim();
  return new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
}

export function runGit(args, { cwd, allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw commandError(args, result);
  return result;
}

function refExists(repoDir, ref, git) {
  return git(['show-ref', '--verify', '--quiet', ref], {
    cwd: repoDir,
    allowFailure: true,
  }).status === 0;
}

function revParse(repoDir, ref, git) {
  return git(['rev-parse', '--verify', ref], { cwd: repoDir }).stdout.trim();
}

function isAncestor(repoDir, older, newer, git) {
  return git(['merge-base', '--is-ancestor', older, newer], {
    cwd: repoDir,
    allowFailure: true,
  }).status === 0;
}

export function refreshExistingRepo(repoDir, { git = runGit } = {}) {
  git(['rev-parse', '--is-inside-work-tree'], { cwd: repoDir });
  git(['fetch', '--prune', 'origin'], { cwd: repoDir });
  git(['worktree', 'prune'], { cwd: repoDir });

  if (!refExists(repoDir, 'refs/remotes/origin/main', git)) {
    throw new Error('origin/main does not exist');
  }

  if (!refExists(repoDir, 'refs/heads/main', git)) {
    git(['branch', '--track', 'main', 'origin/main'], { cwd: repoDir });
    return 'created local main at origin/main';
  }

  const localMain = revParse(repoDir, 'refs/heads/main', git);
  const remoteMain = revParse(repoDir, 'refs/remotes/origin/main', git);
  const worktrees = parseWorktrees(
    git(['worktree', 'list', '--porcelain'], { cwd: repoDir }).stdout,
  );
  const mainWorktree = worktrees.find((entry) => entry.branch === 'refs/heads/main');

  if (mainWorktree) {
    const dirty = git(
      ['status', '--porcelain=v1', '--untracked-files=normal'],
      { cwd: mainWorktree.worktree },
    ).stdout;
    if (dirty.trim()) {
      throw new Error(`main worktree is dirty: ${mainWorktree.worktree}`);
    }
  }

  if (localMain === remoteMain) return 'main already current';

  if (!isAncestor(repoDir, 'refs/heads/main', 'refs/remotes/origin/main', git)) {
    throw new Error('local main is ahead of or diverged from origin/main');
  }

  if (mainWorktree) {
    git(['merge', '--ff-only', 'origin/main'], { cwd: mainWorktree.worktree });
    return `fast-forwarded main in ${mainWorktree.worktree}`;
  }

  // main is not checked out, so an atomic ref update is enough. Supplying the
  // old object ID makes this fail instead of racing another local writer.
  git(['update-ref', 'refs/heads/main', remoteMain, localMain], { cwd: repoDir });
  return 'fast-forwarded local main ref';
}

function assertExpectedOrigin(repoDir, account, name, git) {
  const result = git(['remote', 'get-url', 'origin'], { cwd: repoDir });
  const actual = githubRepository(result.stdout);
  const expected = `${account}/${name}`.toLowerCase();
  if (actual !== expected) {
    throw new Error(`origin is not the expected GitHub repository ${account}/${name}`);
  }
}

export function bootstrapGovernedRepos({
  manifestPath,
  codeDir,
  names = [],
  git = runGit,
  cloneUrlFor = (account, name) => `https://github.com/${account}/${name}.git`,
  verifyOrigin = true,
} = {}) {
  const manifest = loadManifest(manifestPath);
  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    throw new Error(`invalid governed-repository manifest:\n${errors.map((error) => `  - ${error}`).join('\n')}`);
  }

  const included = manifest.repos.filter((repo) => INCLUDED_STATUSES.has(repo.status));
  const byName = new Map(included.map((repo) => [repo.name, repo]));
  const requested = names.length > 0 ? [...new Set(names)] : included.map((repo) => repo.name);
  for (const name of requested) {
    if (!byName.has(name)) {
      throw new Error(`${name} is not an active or onboarding governed repository`);
    }
  }

  mkdirSync(codeDir, { recursive: true });
  const results = [];

  for (const name of requested) {
    const repoDir = path.join(codeDir, name);
    try {
      if (!existsSync(repoDir)) {
        git(['clone', cloneUrlFor(manifest.account, name), repoDir], { cwd: codeDir });
        results.push({ name, action: 'cloned', detail: repoDir });
        continue;
      }
      if (!statSync(repoDir).isDirectory()) {
        throw new Error(`${repoDir} exists but is not a directory`);
      }
      if (verifyOrigin) assertExpectedOrigin(repoDir, manifest.account, name, git);
      const detail = refreshExistingRepo(repoDir, { git });
      results.push({ name, action: 'updated', detail });
    } catch (error) {
      results.push({ name, action: 'failed', detail: error.message });
    }
  }

  return results;
}

function usage() {
  return [
    'Usage: node tools/repos/bootstrap.mjs [options]',
    '',
    'Options:',
    '  --code-dir <dir>   clone root (default: ~/Code)',
    '  --manifest <file>  governed-repository manifest',
    '  --repo <name>      scope to one repo; repeatable',
    '  -h, --help         show this help',
  ].join('\n');
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(usage());
    return;
  }

  let results;
  try {
    results = bootstrapGovernedRepos({
      manifestPath: args.manifest,
      codeDir: args.codeDir,
      names: args.repos,
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  for (const result of results) {
    const mark = result.action === 'failed' ? 'FAILED' : result.action;
    console.log(`${mark} ${result.name}: ${result.detail}`);
  }
  const failures = results.filter((result) => result.action === 'failed');
  console.log(`${results.length - failures.length}/${results.length} governed repositories ready.`);
  if (failures.length > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
