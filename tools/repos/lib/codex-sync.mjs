// Pure contracts for fleet synchronization of centrally managed agent harness
// files. Network orchestration lives in ../sync-codex.mjs; this module keeps
// content comparison, manifest selection, and stable-branch decisions
// deterministic and unit-testable. Legacy CODEX_* export names remain the
// local CLI/API surface while the synchronization identity is vendor-neutral.

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GOVERNED_HARNESS_FILES } from './baseline-files.mjs';

export const CODEX_SYNC_BRANCH = 'governance/harness-sync';
export const CODEX_SYNC_BOT = 'chores-dumb';
export const CODEX_REVIEW_BOT = 'chatgpt-codex-connector[bot]';
export const COPILOT_REVIEW_BOT = 'copilot-pull-request-reviewer[bot]';
export const CODEX_SOURCE_REPO = 'playbook-engineering';
export const CODEX_SYNC_TITLE = 'governance: sync managed agent harness files';
export const CODEX_SYNC_COMMIT_PREFIX = `governance: sync agent harness from ${CODEX_SOURCE_REPO}@`;
// Paths governance owns inside a downstream JSON file; everything else in that
// file belongs to the repo and survives a sync untouched. `hooks.PreToolUse`
// joined the list with ENG-0138: the memory guard is only a fleet control if
// every repo's hook wiring is governed, and a repo that quietly edited it back
// out would be the one machine-scoped budgeting cannot see. The remaining
// Claude hook events joined with ENG-0128 so uninstalled identity adapters
// propagate; a missing ownership row fails closed rather than dropping them.
export const MANAGED_JSON_OVERLAYS = new Map([
  ['.claude/settings.json', [
    ['$schema'],
    ['hooks', 'PreToolUse'],
    ['hooks', 'WorktreeCreate'],
    ['hooks', 'SessionStart'],
    ['hooks', 'SessionEnd'],
    ['hooks', 'UserPromptSubmit'],
    ['hooks', 'PostToolUse'],
    ['hooks', 'Stop'],
  ]],
]);

export function gitBlobSha(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
}

export function loadCanonicalFiles(root, paths = GOVERNED_HARNESS_FILES) {
  return new Map(paths.map((path) => {
    const absolute = join(root, path);
    const content = readFileSync(absolute);
    const executable = (statSync(absolute).mode & 0o111) !== 0;
    return [path, {
      path,
      content,
      sha: gitBlobSha(content),
      mode: executable ? '100755' : '100644',
    }];
  }));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const PROTOTYPE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function assertSafeJsonPath(path) {
  const unsafe = path.find((segment) => PROTOTYPE_PATH_SEGMENTS.has(segment));
  if (unsafe) throw new Error(`refusing prototype-sensitive JSON path segment ${JSON.stringify(unsafe)}`);
}

function pathValue(source, path) {
  assertSafeJsonPath(path);
  let value = source;
  for (const segment of path) {
    if (!isPlainObject(value) || !Object.hasOwn(value, segment)) {
      return { exists: false, value: undefined };
    }
    value = value[segment];
  }
  return { exists: true, value };
}

function setPathValue(target, path, value) {
  assertSafeJsonPath(path);
  let parent = target;
  for (const segment of path.slice(0, -1)) {
    if (!Object.hasOwn(parent, segment)) parent[segment] = {};
    else if (!isPlainObject(parent[segment])) {
      throw new Error(`JSON path ${path.join('.')} collides with non-object ${segment}`);
    }
    parent = parent[segment];
  }
  parent[path.at(-1)] = value;
}

function deletePathValue(target, path) {
  assertSafeJsonPath(path);
  let parent = target;
  for (const segment of path.slice(0, -1)) {
    if (!isPlainObject(parent[segment])) return;
    parent = parent[segment];
  }
  delete parent[path.at(-1)];
}

function leafPaths(value, parent = []) {
  if (!isPlainObject(value)) return [parent];
  const entries = Object.entries(value);
  if (entries.length === 0) return parent.length ? [parent] : [];
  return entries.flatMap(([key, child]) => leafPaths(child, [...parent, key]));
}

function containsAnyMarker(value, markers) {
  const encoded = JSON.stringify(value);
  return markers.some((marker) => encoded.includes(marker));
}

function preservedArrayEntries(value, markers, parent = [], found = []) {
  if (Array.isArray(value)) {
    const seen = new Set();
    const entries = value.filter((entry) => {
      if (!containsAnyMarker(entry, markers)) return false;
      const encoded = JSON.stringify(entry);
      if (seen.has(encoded)) return false;
      seen.add(encoded);
      return true;
    });
    if (entries.length) found.push({ path: parent, entries });
    return found;
  }
  if (!isPlainObject(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    preservedArrayEntries(child, markers, [...parent, key], found);
  }
  return found;
}

function composePreservedArrayEntries(managed, preservedEntries, markers) {
  for (const preserved of preservedEntries) {
    const candidate = pathValue(managed, preserved.path);
    if (candidate.exists && !Array.isArray(candidate.value)) {
      throw new Error(
        `preserved array path ${preserved.path.join('.')} collides with canonical non-array value`,
      );
    }
    const current = candidate.exists ? candidate.value : [];
    const foreign = current.filter((entry) => !containsAnyMarker(entry, markers));
    setPathValue(managed, preserved.path, [...foreign, ...preserved.entries]);
  }
  return managed;
}

function parseJsonObject(path, content, owner) {
  let value;
  try {
    value = JSON.parse(content.toString('utf8'));
  } catch (error) {
    throw new Error(`${path}: invalid ${owner} JSON (${error.message})`);
  }
  if (!isPlainObject(value)) throw new Error(`${path}: ${owner} JSON must be an object`);
  return value;
}

export function mergeManagedFile(
  canonicalFile,
  targetContent,
  { preserveArrayEntriesContaining = [] } = {},
) {
  const ownedPaths = MANAGED_JSON_OVERLAYS.get(canonicalFile.path);
  if (!ownedPaths && preserveArrayEntriesContaining.length === 0) return canonicalFile;
  const managed = parseJsonObject(canonicalFile.path, canonicalFile.content, 'managed');
  if (ownedPaths) {
    const owned = new Set(ownedPaths.map((path) => JSON.stringify(path)));
    for (const path of leafPaths(managed)) {
      if (!owned.has(JSON.stringify(path))) {
        throw new Error(
          `${canonicalFile.path}: canonical JSON path ${path.join('.')} has no managed ownership`,
        );
      }
    }
  }
  if (!targetContent) return canonicalFile;
  const target = parseJsonObject(canonicalFile.path, targetContent, 'downstream');
  const preservedEntries = preservedArrayEntries(target, preserveArrayEntriesContaining);
  let desired = managed;
  if (ownedPaths) {
    desired = target;
    for (const path of ownedPaths) {
      const candidate = pathValue(managed, path);
      if (candidate.exists) setPathValue(desired, path, candidate.value);
      else deletePathValue(desired, path);
    }
  }
  composePreservedArrayEntries(desired, preservedEntries, preserveArrayEntriesContaining);
  const content = Buffer.from(`${JSON.stringify(desired, null, 2)}\n`);
  return {
    ...canonicalFile,
    content,
    sha: gitBlobSha(content),
  };
}

export async function materializeManagedFiles(
  canonicalFiles,
  targetTree,
  managedPaths,
  readTargetContent,
  preserveJsonArrayEntries = {},
) {
  const files = new Map();
  for (const path of managedPaths) {
    const canonical = canonicalFiles.get(path);
    if (!canonical) throw new Error(`${path}: canonical managed file is missing`);
    const target = targetTree.get(path);
    const markers = preserveJsonArrayEntries[path] ?? [];
    const content = target && (MANAGED_JSON_OVERLAYS.has(path) || markers.length)
      ? await readTargetContent(target)
      : null;
    files.set(path, mergeManagedFile(canonical, content, {
      preserveArrayEntriesContaining: markers,
    }));
  }
  return files;
}

export function managedCodexPaths(entry, paths = GOVERNED_HARNESS_FILES) {
  if (entry.codexSync?.enabled === false) return [];
  const excluded = new Set(entry.codexSync?.exclude ?? []);
  return paths.filter((path) => !excluded.has(path));
}

export function treeByPath(tree) {
  return new Map(
    (tree ?? [])
      .filter((entry) => entry.type === 'blob')
      .map((entry) => [entry.path, entry]),
  );
}

export function diffManagedFiles(canonicalFiles, targetTree, managedPaths) {
  const target = targetTree instanceof Map ? targetTree : treeByPath(targetTree);
  return managedPaths
    .filter((path) => {
      const source = canonicalFiles.get(path);
      const current = target.get(path);
      return !current || current.sha !== source.sha || current.mode !== source.mode;
    })
    .map((path) => canonicalFiles.get(path));
}

export function chooseSyncHead({ baseSha, branchSha, branchOwned = false, pulls }) {
  const branchPulls = (pulls ?? []).filter((pull) => pull.head?.ref === CODEX_SYNC_BRANCH);
  if (branchPulls.some((pull) => pull.title !== CODEX_SYNC_TITLE)) {
    throw new Error(`${CODEX_SYNC_BRANCH} is attached to a non-sync pull request`);
  }
  const open = branchPulls.filter((pull) => pull.state === 'open');
  if (open.length > 1) {
    throw new Error(`multiple open ${CODEX_SYNC_BRANCH} pull requests found`);
  }
  if (open.length === 1) {
    if (!branchSha) throw new Error(`open sync pull request #${open[0].number} has no branch ref`);
    return { parentSha: branchSha, pull: open[0], resetBranch: false };
  }
  if (branchSha && branchPulls.length === 0 && !branchOwned) {
    throw new Error(`refusing to reset unowned branch ${CODEX_SYNC_BRANCH}`);
  }
  return { parentSha: baseSha, pull: null, resetBranch: Boolean(branchSha) };
}

export function syncPullBody({ owner, sourceSha, paths }) {
  const sourceUrl = `https://github.com/${owner}/${CODEX_SOURCE_REPO}/commit/${sourceSha}`;
  const managed = paths.map((path) => `- \`${path}\``).join('\n');
  return [
    `Synchronizes the centrally managed agent-harness environment (\`.codex/\`, \`.claude/\`) from [\`${sourceSha.slice(0, 12)}\`](${sourceUrl}).`,
    '',
    'Managed files:',
    '',
    managed,
    '',
    `Generated by \`node tools/repos/sync-codex.mjs --apply\` for ${owner}/${CODEX_SOURCE_REPO}#60.`,
    'This pull request is bot-authored, requires the target repository checks and review, and never writes to the default branch directly.',
  ].join('\n');
}

export function validateSyncApprovalCandidate({
  owner,
  entry,
  metadata,
  pull,
  files,
}) {
  const repo = entry.name;
  const fullName = `${owner}/${repo}`;
  const allowedPaths = new Set(managedCodexPaths(entry));
  const errors = [];

  if (pull.title !== CODEX_SYNC_TITLE) {
    errors.push(`title must be ${JSON.stringify(CODEX_SYNC_TITLE)}`);
  }
  if (pull.user?.login !== `${CODEX_SYNC_BOT}[bot]` || pull.user?.type !== 'Bot') {
    errors.push(`author must be ${CODEX_SYNC_BOT}[bot]`);
  }
  if (pull.draft) errors.push('pull request must be ready for review');
  if (pull.head?.ref !== CODEX_SYNC_BRANCH || pull.head?.repo?.full_name !== fullName) {
    errors.push(`head must be ${fullName}:${CODEX_SYNC_BRANCH}`);
  }
  if (pull.base?.ref !== metadata.default_branch || pull.base?.repo?.full_name !== fullName) {
    errors.push(`base must be ${fullName}:${metadata.default_branch}`);
  }
  const sourcePattern = new RegExp(
    `https://github\\.com/${owner}/${CODEX_SOURCE_REPO}/commit/[0-9a-f]{40}`,
    'i',
  );
  if (!sourcePattern.test(pull.body ?? '')) {
    errors.push(`body must identify a ${owner}/${CODEX_SOURCE_REPO} source commit`);
  }
  if (!Array.isArray(files) || files.length === 0) {
    errors.push('pull request must change at least one managed file');
  } else {
    for (const file of files) {
      if (!allowedPaths.has(file.filename)) {
        errors.push(`unmanaged changed path: ${file.filename}`);
      }
      if (!['added', 'modified', 'changed'].includes(file.status)) {
        errors.push(`unsupported ${file.status} change: ${file.filename}`);
      }
    }
  }
  return errors;
}

export function preferredMergeFlag(metadata) {
  if (metadata.allow_merge_commit) return '--merge';
  if (metadata.allow_squash_merge) return '--squash';
  if (metadata.allow_rebase_merge) return '--rebase';
  throw new Error(`${metadata.full_name ?? metadata.name}: no repository merge method is enabled`);
}

export function assertHumanLogin(login) {
  if (!login || login.endsWith('[bot]')) {
    throw new Error(`--apply requires a human GitHub identity; authenticated as ${login ?? 'unknown'}`);
  }
  return login;
}

export function cleanAiReviewEvidence({
  headSha,
  headCommittedAt,
  reviews = [],
  reviewComments = [],
  issueComments = [],
  issueReactions = [],
  commentReactions = [],
}) {
  const headTime = Date.parse(headCommittedAt);
  if (!headSha || Number.isNaN(headTime)) return [];
  const current = (timestamp) => {
    const time = Date.parse(timestamp);
    return !Number.isNaN(time) && time >= headTime;
  };
  const evidence = [];

  const codexThumb = issueReactions.find((reaction) =>
    reaction.content === '+1' &&
    reaction.user?.login === CODEX_REVIEW_BOT &&
    current(reaction.created_at)) ??
    commentReactions.find((reaction) =>
      reaction.content === '+1' &&
      reaction.user?.login === CODEX_REVIEW_BOT &&
      current(reaction.created_at) &&
      /@codex\s+review\b/i.test(reaction.parentBody ?? ''));
  if (codexThumb) {
    evidence.push({
      provider: 'codex',
      kind: 'thumbs-up',
      at: codexThumb.created_at,
    });
  }

  const cleanCopilotReview = reviews.find((review) =>
    review.user?.login === COPILOT_REVIEW_BOT &&
    review.state === 'COMMENTED' &&
    review.commit_id === headSha &&
    !reviewComments.some((comment) => comment.pull_request_review_id === review.id));
  const cleanCopilotComment = issueComments.find((comment) =>
    comment.user?.login === COPILOT_REVIEW_BOT &&
    current(comment.created_at) &&
    /\bdid(?: not|n['’]t) find anything to comment on\b/i.test(comment.body ?? ''));
  if (cleanCopilotReview || cleanCopilotComment) {
    evidence.push({
      provider: 'copilot',
      kind: cleanCopilotReview ? 'comment-review-with-no-findings' : 'clean-comment',
      at: cleanCopilotReview?.submitted_at ?? cleanCopilotComment.created_at,
    });
  }

  return evidence;
}
