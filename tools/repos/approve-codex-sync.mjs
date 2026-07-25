#!/usr/bin/env node
// Human-invoked review helper for governed Codex synchronization pull requests.
//
//   node tools/repos/approve-codex-sync.mjs [--apply] [--repo <name>] [--json]
//
// Dry-run is the default. Apply refuses bot identities, validates every pull
// request before acting, submits the human approval, and arms auto-merge.

import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CODEX_SOURCE_REPO,
  CODEX_SYNC_BRANCH,
  assertHumanLogin,
  cleanAiReviewEvidence,
  preferredMergeFlag,
  validateSyncApprovalCandidate,
} from './lib/codex-sync.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export class GhClient {
  constructor(exec = execFileSync) {
    this.exec = exec;
  }

  output(args) {
    return this.exec('gh', args, {
      cwd: ROOT,
      encoding: 'utf8',
      env: process.env,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  }

  json(args) {
    return JSON.parse(this.output(args));
  }

  pages(path) {
    return this.json(['api', '--paginate', '--slurp', path]).flat();
  }

  run(args) {
    this.exec('gh', args, {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
    });
  }
}

export function parseArgs(argv) {
  const options = { apply: false, json: false, repo: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') options.apply = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--repo') {
      options.repo = argv[index + 1];
      index += 1;
      if (!options.repo) throw new Error('--repo requires a repository name');
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (options.repo && !/^[\w.-]+$/.test(options.repo)) {
    throw new Error(`invalid repository name: ${options.repo}`);
  }
  return options;
}

export function viewerLogin(client) {
  const result = client.json([
    'api',
    'graphql',
    '-f',
    'query=query { viewer { login } }',
  ]);
  return result.data?.viewer?.login ?? null;
}

export function reviewRepository(client, {
  owner,
  entry,
  actor,
  apply,
}) {
  const repo = entry.name;
  const fullName = `${owner}/${repo}`;
  const metadata = client.json(['api', `/repos/${fullName}`]);
  const head = encodeURIComponent(`${owner}:${CODEX_SYNC_BRANCH}`);
  const pulls = client.pages(
    `/repos/${fullName}/pulls?state=open&head=${head}&per_page=100`,
  );
  if (pulls.length === 0) {
    return { name: repo, status: 'none', changed: [] };
  }
  if (pulls.length > 1) {
    return {
      name: repo,
      status: 'refused',
      changed: [],
      errors: [`multiple open ${CODEX_SYNC_BRANCH} pull requests found`],
    };
  }

  const pull = client.json(['api', `/repos/${fullName}/pulls/${pulls[0].number}`]);
  const files = client.pages(`/repos/${fullName}/pulls/${pull.number}/files?per_page=100`);
  const errors = validateSyncApprovalCandidate({
    owner,
    entry,
    metadata,
    pull,
    files,
  });
  if (errors.length > 0) {
    return {
      name: repo,
      status: 'refused',
      pull: pull.html_url,
      changed: files.map((file) => file.filename),
      errors,
    };
  }

  const headCommit = client.json(['api', `/repos/${fullName}/commits/${pull.head.sha}`]);
  const headCommittedAt =
    headCommit.commit?.committer?.date ?? headCommit.commit?.author?.date;
  const reviews = client.pages(`/repos/${fullName}/pulls/${pull.number}/reviews?per_page=100`);
  const reviewComments = client.pages(
    `/repos/${fullName}/pulls/${pull.number}/comments?per_page=100`,
  );
  const issueComments = client.pages(
    `/repos/${fullName}/issues/${pull.number}/comments?per_page=100`,
  );
  const issueReactions = client.pages(
    `/repos/${fullName}/issues/${pull.number}/reactions?per_page=100`,
  );
  const headTime = Date.parse(headCommittedAt);
  const currentIssueComments = issueComments.filter((comment) => {
    const created = Date.parse(comment.created_at);
    return !Number.isNaN(headTime) && !Number.isNaN(created) && created >= headTime;
  });
  const commentReactions = currentIssueComments.flatMap((comment) =>
    client.pages(`/repos/${fullName}/issues/comments/${comment.id}/reactions?per_page=100`)
      .map((reaction) => ({ ...reaction, parentBody: comment.body })));
  const aiReview = cleanAiReviewEvidence({
    headSha: pull.head.sha,
    headCommittedAt,
    reviews,
    reviewComments,
    issueComments,
    issueReactions,
    commentReactions,
  });
  if (aiReview.length === 0) {
    return {
      name: repo,
      status: 'refused',
      pull: pull.html_url,
      changed: files.map((file) => file.filename),
      errors: ['no clean current-head Codex or Copilot review evidence'],
    };
  }

  const approved = reviews.some((review) =>
    review.user?.login === actor &&
    review.state === 'APPROVED' &&
    review.commit_id === pull.head.sha);
  const mergeFlag = preferredMergeFlag(metadata);
  const result = {
    name: repo,
    status: apply ? 'applied' : 'ready',
    pull: pull.html_url,
    number: pull.number,
    changed: files.map((file) => file.filename),
    approved,
    autoMerge: Boolean(pull.auto_merge),
    mergeMethod: mergeFlag.slice(2),
    aiReview,
  };
  if (!apply) return result;

  if (!approved) {
    client.run([
      'pr',
      'review',
      String(pull.number),
      '--repo',
      fullName,
      '--approve',
      '--body',
      'Approved after local governed Codex sync validation.',
    ]);
  }
  if (!pull.auto_merge) {
    client.run([
      'pr',
      'merge',
      String(pull.number),
      '--repo',
      fullName,
      '--auto',
      mergeFlag,
    ]);
  }
  return result;
}

function usage() {
  return [
    'Usage: node tools/repos/approve-codex-sync.mjs [--apply] [--repo NAME] [--json]',
    '',
    'Dry-run is the default. --apply requires a human gh identity, approves only',
    'validated qwts-codex-agent synchronization PRs, and arms auto-merge.',
  ].join('\n');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const manifest = JSON.parse(readFileSync(join(ROOT, 'governance', 'repos.json'), 'utf8'));
  const entries = manifest.repos.filter((entry) =>
    entry.status === 'active' &&
    entry.name !== CODEX_SOURCE_REPO &&
    entry.codexSync?.enabled !== false &&
    (!options.repo || entry.name === options.repo));
  if (options.repo && entries.length === 0) {
    throw new Error(`--repo ${options.repo}: not an enabled active target repository`);
  }

  const client = new GhClient();
  const actor = viewerLogin(client);
  if (options.apply) assertHumanLogin(actor);
  const results = entries.map((entry) => {
    try {
      return reviewRepository(client, {
        owner: manifest.account,
        entry,
        actor,
        apply: options.apply,
      });
    } catch (error) {
      return {
        name: entry.name,
        status: 'error',
        changed: [],
        errors: [error.message],
      };
    }
  });
  if (results.some((result) => ['refused', 'error'].includes(result.status))) {
    process.exitCode = 1;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ actor, apply: options.apply, results }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`GitHub identity: ${actor ?? 'unknown'}\n`);
  for (const result of results) {
    const pull = result.pull ? ` — ${result.pull}` : '';
    const errors = result.errors?.length ? ` — ${result.errors.join('; ')}` : '';
    process.stdout.write(`${result.name}: ${result.status}${pull}${errors}\n`);
  }
  if (!options.apply) {
    process.stdout.write(
      '\ndry run — inspect the plan, then run from your human checkout with --apply\n',
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`approve-codex-sync: ${error.message}`);
    process.exit(1);
  }
}
