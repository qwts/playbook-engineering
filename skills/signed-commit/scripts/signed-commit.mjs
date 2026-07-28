#!/usr/bin/env node
/**
 * Replay the local commits on this branch as GitHub-signed commits.
 *
 * Commits created through the Git Data API are signed by GitHub's own key and
 * show Verified. Commits made by `git commit` in a bot worktree cannot be:
 * agent-bot worktrees deliberately set commit.gpgsign=false, because signing a
 * bot commit with the human's GPG/SSH key shows Unverified (the key does not
 * match the bot's committer email). See playbook-engineering
 * docs/reference/agent-bot-identity.md.
 *
 * Usage:
 *   node signed-commit.mjs [--base <ref>] [--branch <name>] [--repo owner/name]
 *                          [--dry-run] [--allow-default-branch]
 *
 * Defaults: repo and branch from the current checkout, base from the
 * merge-base with the remote default branch.
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const DRY_RUN = has('dry-run');

function git(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

function gitTrim(args) {
  return git(args).trim();
}

function gh(args, input) {
  return execFileSync('gh', args, {
    input,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function api(path, method = 'GET', body) {
  const args = ['api', path, '-X', method];
  if (body) args.push('--input', '-');
  try {
    return JSON.parse(gh(args, body ? JSON.stringify(body) : undefined));
  } catch (error) {
    const detail = (error.stderr ?? '').toString().trim() || error.message;
    throw new Error(`${method} ${path} failed: ${detail}`);
  }
}

function die(message) {
  console.error(`signed-commit: ${message}`);
  process.exit(1);
}

// An unexpected throw must read as a clear failure, not a stack trace. Nothing
// below the replay loop writes anything, so an abort here leaves the remote
// untouched and the created commits unreferenced.
process.on('uncaughtException', (error) => die(error.message.trim()));
process.on('unhandledRejection', (error) => die(String(error?.message ?? error).trim()));

// ---------------------------------------------------------------- context

if (gitTrim(['status', '--porcelain'])) {
  die('working tree is dirty — commit or stash first, so the signed commit matches what you tested');
}

const repo = flag('repo') ?? (() => {
  try {
    return JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;
  } catch {
    die('could not determine the repository — pass --repo owner/name');
  }
})();

const branch = flag('branch') ?? gitTrim(['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch === 'HEAD') die('detached HEAD — pass --branch <name>');

const defaultBranch = (() => {
  try {
    return JSON.parse(gh(['repo', 'view', '--json', 'defaultBranchRef'])).defaultBranchRef.name;
  } catch {
    return 'main';
  }
})();

if (branch === defaultBranch && !has('allow-default-branch')) {
  die(`refusing to rewrite the default branch (${defaultBranch}) — pass --allow-default-branch if you mean it`);
}

const base = (() => {
  const explicit = flag('base');
  if (explicit) return gitTrim(['rev-parse', explicit]);
  for (const ref of [`origin/${defaultBranch}`, defaultBranch]) {
    try {
      return gitTrim(['merge-base', ref, 'HEAD']);
    } catch {
      /* try the next candidate */
    }
  }
  return die(`could not find a merge-base with ${defaultBranch} — pass --base <ref>`);
})();

const head = gitTrim(['rev-parse', 'HEAD']);
if (base === head) die('nothing to sign — HEAD is already at the base');

const commits = gitTrim(['rev-list', '--reverse', `${base}..${head}`]).split('\n').filter(Boolean);

for (const sha of commits) {
  const parents = gitTrim(['rev-list', '--parents', '-n', '1', sha]).split(/\s+/).slice(1);
  if (parents.length > 1) {
    die(`${sha.slice(0, 8)} is a merge commit — rebase into linear history before signing`);
  }
}

const ref = `heads/${branch}`;

/** The remote head, or `null` when the branch does not exist yet. */
function readRemoteRef() {
  try {
    return api(`repos/${repo}/git/refs/${ref}`).object.sha;
  } catch (error) {
    // A missing ref is an ordinary answer; anything else is a real failure and
    // must not be mistaken for "the branch does not exist yet".
    if (/Not Found|404/u.test(String(error.message))) return null;
    throw error;
  }
}

// Recorded before replay so the final force cannot overwrite a head this run
// never observed. The force itself is unavoidable — replayed commits are not
// descendants of the local ones — but forcing past someone else's push is not.
//
// Skipped under --dry-run: a preview writes nothing, so it needs no lease, and
// keeping it network-free means it still works from a scratch checkout.
const remoteBefore = DRY_RUN ? null : readRemoteRef();

/**
 * `git push --force-with-lease`, reimplemented — the REST API has no equivalent.
 *
 * The lease is the remote-tracking ref: whatever this checkout last fetched.
 * If the real remote still matches it, every commit up there is one this clone
 * has seen, and replacing them is a deliberate rewrite. If it does not match,
 * someone pushed and those commits would be destroyed silently.
 *
 * Two rejected alternatives, both of which testing killed:
 *
 * - *Compare the ref before and after replay.* Catches a push landing mid-run
 *   and nothing else. A commit pushed before the run started has identical
 *   before and after values, and was silently destroyed in a live test.
 * - *Require the remote head to be an ancestor of HEAD.* Safe, but it forbids
 *   the ordinary squash-or-amend-after-review rewrite, which is most of what
 *   this script is used for.
 *
 * Deliberately does NOT fetch first: fetching would refresh the lease to the
 * value it is supposed to be checking, which is the same caveat git's own
 * --force-with-lease carries.
 */
function assertLeaseHolds(remoteSha) {
  if (!remoteSha) return; // new branch — there is nothing to overwrite

  let seen = null;
  try {
    seen = gitTrim(['rev-parse', '--verify', `refs/remotes/origin/${branch}`]);
  } catch {
    /* no remote-tracking ref in this checkout */
  }

  if (seen !== remoteSha) {
    die(
      `${branch} on the remote is at ${remoteSha.slice(0, 8)}, but this checkout last saw ` +
        `${seen ? seen.slice(0, 8) : 'no remote branch'} — someone else pushed. Nothing was written.\n` +
        `  Recover with: git fetch origin ${branch} && git rebase origin/${branch}`,
    );
  }
}

if (!DRY_RUN) assertLeaseHolds(remoteBefore);

console.log(`repo    ${repo}`);
console.log(`branch  ${branch}`);
console.log(`base    ${base.slice(0, 8)}`);
console.log(
  `remote  ${DRY_RUN ? '(not checked — dry run)' : remoteBefore ? remoteBefore.slice(0, 8) : '(new branch)'}`,
);
console.log(`commits ${commits.length}`);
console.log('');

// ------------------------------------------------------------------ replay

/** Tree entries for one commit's diff against its parent. */
function treeEntriesFor(sha, parent) {
  const raw = gitTrim(['diff', '--name-status', '-M', '-z', parent, sha]);
  if (!raw) return [];

  // -z output: status\0path\0 — renames/copies carry two paths.
  const fields = raw.split('\0').filter((f) => f !== '');
  const entries = [];

  for (let i = 0; i < fields.length; ) {
    const status = fields[i++];
    const pathA = fields[i++];
    const pathB = /^[RC]/.test(status) ? fields[i++] : null;

    if (status.startsWith('D')) {
      entries.push({ path: pathA, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    if (pathB !== null && status.startsWith('R')) {
      // A rename deletes the old path and adds the new one.
      entries.push({ path: pathA, mode: '100644', type: 'blob', sha: null });
    }

    const file = pathB ?? pathA;
    const meta = gitTrim(['ls-tree', sha, '--', file]);
    if (!meta) die(`could not read ${file} from ${sha.slice(0, 8)}`);
    const [mode, objectType] = meta.split(/\s+/);

    if (objectType === 'commit') {
      die(`${file} is a submodule — the Git Data API path does not handle submodule bumps`);
    }

    const content = git(['show', `${sha}:${file}`], { encoding: 'buffer' });
    const blob = DRY_RUN
      ? { sha: '0'.repeat(40) }
      : api(`repos/${repo}/git/blobs`, 'POST', {
          content: content.toString('base64'),
          encoding: 'base64',
        });

    entries.push({ path: file, mode, type: 'blob', sha: blob.sha });
  }

  return entries;
}

let parentSha = base;
let parentApiSha = base;
let parentTreeSha = gitTrim(['rev-parse', `${base}^{tree}`]);

for (const sha of commits) {
  const subject = gitTrim(['log', '-1', '--format=%s', sha]);
  const message = git(['log', '-1', '--format=%B', sha]).trim();
  const entries = treeEntriesFor(sha, parentSha);

  console.log(`${sha.slice(0, 8)} ${subject}`);
  for (const e of entries) {
    console.log(`  ${e.sha === null ? 'delete' : `write ${e.mode}`} ${e.path}`);
  }
  if (entries.length === 0) console.log('  (empty commit — replayed, not dropped)');

  if (DRY_RUN) {
    parentSha = sha;
    continue;
  }

  // An empty commit is still a commit, and often a deliberate marker. Reusing
  // the parent's tree replays it rather than dropping it, which would silently
  // break the promise that every commit is preserved individually.
  const treeSha = entries.length
    ? api(`repos/${repo}/git/trees`, 'POST', { base_tree: parentApiSha, tree: entries }).sha
    : parentTreeSha;

  const created = api(`repos/${repo}/git/commits`, 'POST', {
    message,
    tree: treeSha,
    parents: [parentApiSha],
  });

  // The whole point of the exercise — do not continue on an unsigned result.
  if (!created.verification?.verified) {
    die(`${created.sha.slice(0, 8)} came back unsigned (${created.verification?.reason ?? 'no reason given'})`);
  }

  // The signed commit must contain byte-identical content to the commit that
  // was reviewed and tested locally, or CI validated something else.
  const localTree = gitTrim(['rev-parse', `${sha}^{tree}`]);
  if (localTree !== treeSha) {
    die(
      `tree mismatch on ${sha.slice(0, 8)}: local ${localTree.slice(0, 8)} vs signed ${treeSha.slice(0, 8)} — ` +
        'the signed commit would not match what you tested',
    );
  }

  console.log(`  -> ${created.sha.slice(0, 8)} verified (${created.verification.reason})`);
  parentSha = sha;
  parentApiSha = created.sha;
  parentTreeSha = treeSha;
}

if (DRY_RUN) {
  console.log('\ndry run — nothing was created or pushed');
  process.exit(0);
}

// -------------------------------------------------------------------- push

// Re-read rather than trusting the pre-replay value: replay takes one API call
// per file and can run for a while, which is exactly the window another agent
// pushes into. The API has no force-with-lease, so this is the lease.
const remoteNow = readRemoteRef();
if (remoteNow !== remoteBefore) {
  die(
    `${branch} moved on the remote during replay ` +
      `(${remoteBefore ? remoteBefore.slice(0, 8) : 'absent'} -> ${remoteNow ? remoteNow.slice(0, 8) : 'absent'}) — ` +
      'fetch and rebase, then sign again. Nothing was pushed; the signed commits are unreferenced and will be ' +
      'garbage-collected.',
  );
}

// PATCH vs POST is decided by what was actually observed, not by catching the
// failure of one and guessing the other: a permissions error or a protected
// branch would otherwise surface as a confusing "reference already exists".
if (remoteBefore === null) {
  api(`repos/${repo}/git/refs`, 'POST', { ref: `refs/${ref}`, sha: parentApiSha });
} else {
  // Still forced: replayed commits are not descendants of what is there.
  api(`repos/${repo}/git/refs/${ref}`, 'PATCH', { sha: parentApiSha, force: true });
}

console.log(`\n${branch} -> ${parentApiSha}`);

// Leave the local branch pointing at the signed history, so later work builds
// on what is actually on the remote rather than the discarded local commits.
// The remote is already updated by this point, so a failure here is a local
// inconvenience — say so, rather than letting it read as a failed push.
try {
  git(['fetch', 'origin', branch, '--quiet']);
  git(['reset', '--hard', parentApiSha, '--quiet']);
  console.log('local branch reset to the signed history');
} catch (error) {
  console.error(
    `\nPUSH SUCCEEDED — ${branch} is at ${parentApiSha} on the remote.\n` +
      `Only the local reset failed (${error.message.trim()}).\n` +
      `Recover with: git fetch origin ${branch} && git reset --hard ${parentApiSha}`,
  );
  process.exit(1);
}
