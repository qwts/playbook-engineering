#!/usr/bin/env node
// Fleet synchronization for the centrally managed agent harness files. Adds
// and updates the governed inventory downstream, and deletes paths recorded
// as retired (RETIRED_HARNESS_FILES) — files the sync once delivered and has
// stopped managing (#287).
//
//   node tools/repos/sync-codex.mjs [--apply] [--repo <name>] [--json]
//
// Dry-run is the default. Apply creates or updates one chores-dumb-authored
// pull request per drifting active repository. It never writes a default
// branch and fails closed unless the supplied installation token belongs to
// chores-dumb. A local dry run may mint the current worktree agent's read token.

import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mintAgentToken } from './lib/agent-bot-client.mjs';
import {
  CODEX_SOURCE_REPO,
  CODEX_SYNC_BOT,
  CODEX_SYNC_BRANCH,
  CODEX_SYNC_COMMIT_PREFIX,
  CODEX_SYNC_TITLE,
  chooseSyncHead,
  diffManagedFiles,
  loadCanonicalFiles,
  materializeManagedFiles,
  managedCodexPaths,
  retiredCodexPaths,
  staleRetiredPaths,
  syncPullBody,
  treeByPath,
  withdrawnPathResets,
} from './lib/codex-sync.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = 'https://api.github.com';

function apiRef(prefix, branch) {
  return `${prefix}/${branch.split('/').map(encodeURIComponent).join('/')}`;
}

export class GitHubClient {
  constructor(token, fetchImpl = fetch) {
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async call(method, path, body, { allow404 = false } = {}) {
    const response = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'qwts-codex-sync',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (allow404 && response.status === 404) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`${method} ${path} -> ${response.status}: ${data.message ?? 'unknown error'}`);
    }
    return data;
  }
}

export async function installationToken({ apply, env = process.env, mintToken = mintAgentToken } = {}) {
  if (env.GH_TOKEN) return env.GH_TOKEN;
  if (apply) {
    throw new Error(`--apply requires a GH_TOKEN for ${CODEX_SYNC_BOT}[bot]`);
  }
  const grant = await mintToken({ env });
  return grant.token;
}

async function assertBotIdentity(client) {
  const identity = await client.call('POST', '/graphql', {
    query: 'query { viewer { login } }',
  });
  const login = identity.data?.viewer?.login;
  if (login !== `${CODEX_SYNC_BOT}[bot]`) {
    throw new Error(
      `refusing GitHub writes: expected ${CODEX_SYNC_BOT}[bot], authenticated as ${login ?? 'unknown'}`,
    );
  }
}

function sourceCommit(env = process.env) {
  const sha = env.GITHUB_SHA ||
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`invalid source commit: ${sha}`);
  return sha.toLowerCase();
}

async function commitTree(client, owner, repo, commitSha) {
  const commit = await client.call('GET', `/repos/${owner}/${repo}/git/commits/${commitSha}`);
  const tree = await client.call('GET', `/repos/${owner}/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
  if (tree.truncated) throw new Error(`${owner}/${repo}: recursive tree response was truncated`);
  return treeByPath(tree.tree);
}

async function readBlob(client, owner, repo, entry) {
  const blob = await client.call('GET', `/repos/${owner}/${repo}/git/blobs/${entry.sha}`);
  if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
    throw new Error(`${owner}/${repo}:${entry.path}: unsupported Git blob encoding`);
  }
  return Buffer.from(blob.content.replaceAll('\n', ''), 'base64');
}

async function writeManagedCommit(client, {
  owner,
  repo,
  parentSha,
  sourceSha,
  files,
  removals = [],
  resets = [],
}) {
  const parent = await client.call('GET', `/repos/${owner}/${repo}/git/commits/${parentSha}`);
  const entries = [];
  for (const file of files) {
    const blob = await client.call('POST', `/repos/${owner}/${repo}/git/blobs`, {
      content: file.content.toString('base64'),
      encoding: 'base64',
    });
    entries.push({ path: file.path, mode: file.mode, type: 'blob', sha: blob.sha });
  }
  // A null sha atop base_tree is the Git data API's file deletion.
  for (const path of removals) {
    entries.push({ path, mode: '100644', type: 'blob', sha: null });
  }
  // Prebuilt tree entries that return withdrawn paths to base state.
  entries.push(...resets);
  const tree = await client.call('POST', `/repos/${owner}/${repo}/git/trees`, {
    base_tree: parent.tree.sha,
    tree: entries,
  });
  return client.call('POST', `/repos/${owner}/${repo}/git/commits`, {
    message: `${CODEX_SYNC_COMMIT_PREFIX}${sourceSha.slice(0, 12)}`,
    tree: tree.sha,
    parents: [parentSha],
  });
}

export async function syncRepository(client, {
  owner,
  entry,
  canonicalFiles,
  sourceSha,
  apply,
}) {
  const repo = entry.name;
  const paths = managedCodexPaths(entry);
  const retired = retiredCodexPaths(entry);
  if (paths.length === 0 && retired.length === 0) {
    return { name: repo, status: 'excluded', changed: [], removed: [] };
  }

  const metadata = await client.call('GET', `/repos/${owner}/${repo}`);
  const base = metadata.default_branch;
  const baseRef = await client.call('GET', apiRef(`/repos/${owner}/${repo}/git/ref/heads`, base));
  const baseSha = baseRef.object.sha;
  const baseTree = await commitTree(client, owner, repo, baseSha);
  const desiredFiles = await materializeManagedFiles(
    canonicalFiles,
    baseTree,
    paths,
    (entry) => readBlob(client, owner, repo, entry),
    entry.codexSync?.preserveJsonArrayEntries,
    paths,
  );
  const baseDiff = diffManagedFiles(desiredFiles, baseTree, paths);
  const baseRemovals = staleRetiredPaths(baseTree, retired);

  const head = encodeURIComponent(`${owner}:${CODEX_SYNC_BRANCH}`);
  const branchPulls = await client.call(
    'GET',
    `/repos/${owner}/${repo}/pulls?state=all&head=${head}&per_page=100`,
  );
  const branchRef = await client.call(
    'GET',
    apiRef(`/repos/${owner}/${repo}/git/ref/heads`, CODEX_SYNC_BRANCH),
    undefined,
    { allow404: true },
  );
  let branchOwned = false;
  if (branchRef && branchPulls.length === 0) {
    const branchCommit = await client.call(
      'GET',
      `/repos/${owner}/${repo}/git/commits/${branchRef.object.sha}`,
    );
    branchOwned = branchCommit.message?.startsWith(CODEX_SYNC_COMMIT_PREFIX) === true;
  }
  const choice = chooseSyncHead({
    baseSha,
    branchSha: branchRef?.object.sha,
    branchOwned,
    pulls: branchPulls,
  });
  if (baseDiff.length === 0 && baseRemovals.length === 0 && !choice.pull) {
    return { name: repo, status: 'current', changed: [], removed: [] };
  }

  let changed = baseDiff;
  let removed = baseRemovals;
  let resets = [];
  if (choice.pull) {
    const branchTree = await commitTree(client, owner, repo, choice.parentSha);
    changed = diffManagedFiles(desiredFiles, branchTree, paths);
    removed = staleRetiredPaths(branchTree, retired);
    resets = withdrawnPathResets(entry, baseTree, branchTree);
    if (changed.length === 0 && removed.length === 0 && resets.length === 0) {
      return {
        name: repo,
        status: 'pull-current',
        changed: baseDiff.map((file) => file.path),
        removed: baseRemovals,
        pull: choice.pull.html_url,
      };
    }
  }

  const result = {
    name: repo,
    status: apply ? 'pending' : 'planned',
    changed: changed.map((file) => file.path),
    removed,
    restored: resets.map((reset) => reset.path),
    pull: choice.pull?.html_url,
  };
  if (!apply) return result;

  const commit = await writeManagedCommit(client, {
    owner,
    repo,
    parentSha: choice.parentSha,
    sourceSha,
    files: changed,
    removals: removed,
    resets,
  });
  if (choice.pull) {
    await client.call(
      'PATCH',
      apiRef(`/repos/${owner}/${repo}/git/refs/heads`, CODEX_SYNC_BRANCH),
      { sha: commit.sha, force: false },
    );
  } else {
    if (choice.resetBranch) {
      await client.call(
        'DELETE',
        apiRef(`/repos/${owner}/${repo}/git/refs/heads`, CODEX_SYNC_BRANCH),
      );
    }
    await client.call('POST', `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${CODEX_SYNC_BRANCH}`,
      sha: commit.sha,
    });
  }

  const body = syncPullBody({ owner, sourceSha, paths, removed: baseRemovals });
  if (choice.pull) {
    const pull = await client.call('PATCH', `/repos/${owner}/${repo}/pulls/${choice.pull.number}`, {
      title: CODEX_SYNC_TITLE,
      body,
    });
    return { ...result, status: 'pull-updated', pull: pull.html_url, commit: commit.sha };
  }
  const pull = await client.call('POST', `/repos/${owner}/${repo}/pulls`, {
    title: CODEX_SYNC_TITLE,
    head: CODEX_SYNC_BRANCH,
    base,
    body,
  });
  return { ...result, status: 'pull-opened', pull: pull.html_url, commit: commit.sha };
}

function selectedRepo(argv, env = process.env) {
  const flag = argv.indexOf('--repo');
  const value = flag === -1 ? env.CODEX_SYNC_REPO : argv[flag + 1];
  if (flag !== -1 && !value) throw new Error('--repo requires a repository name');
  if (value && !/^[\w.-]+$/.test(value)) throw new Error(`invalid repository name: ${value}`);
  return value || null;
}

async function main() {
  const argv = process.argv;
  const apply = argv.includes('--apply');
  const only = selectedRepo(argv);
  const manifest = JSON.parse(readFileSync(join(ROOT, 'governance', 'repos.json'), 'utf8'));
  const entries = manifest.repos.filter((entry) =>
    entry.status === 'active' &&
    entry.name !== CODEX_SOURCE_REPO &&
    entry.codexSync?.enabled !== false &&
    (!only || entry.name === only));
  if (only && entries.length === 0) {
    throw new Error(`--repo ${only}: not an enabled active target repository`);
  }

  const client = new GitHubClient(await installationToken({ apply }));
  if (apply) await assertBotIdentity(client);
  const canonicalFiles = loadCanonicalFiles(ROOT);
  const sourceSha = sourceCommit();
  const results = [];
  for (const entry of entries) {
    try {
      results.push(await syncRepository(client, {
        owner: manifest.account,
        entry,
        canonicalFiles,
        sourceSha,
        apply,
      }));
    } catch (error) {
      results.push({
        name: entry.name,
        status: 'error',
        changed: [],
        error: error.message,
      });
    }
  }
  if (results.some((result) => result.status === 'error')) process.exitCode = 1;

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }
  for (const result of results) {
    const files = result.changed.length ? ` (${result.changed.join(', ')})` : '';
    const removed = result.removed?.length ? ` (removes ${result.removed.join(', ')})` : '';
    const restored = result.restored?.length ? ` (restores withdrawn ${result.restored.join(', ')})` : '';
    const pull = result.pull ? ` — ${result.pull}` : '';
    const error = result.error ? ` — ${result.error}` : '';
    process.stdout.write(`${result.name}: ${result.status}${files}${removed}${restored}${pull}${error}\n`);
  }
  if (!apply) process.stdout.write('\ndry run — pass --apply to open or update synchronization pull requests\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`sync-codex: ${error.message}`);
    process.exit(1);
  });
}
