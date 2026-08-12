#!/usr/bin/env node
// First-party action pin reachability guard (#156, #183).
//
// A SHA pin exists to give you an auditable answer to "what is CI actually
// running": you can `git log` your way from the default branch to the pinned
// commit. A squash merge breaks that — the reviewed *content* lands on main as
// a new commit, and the pre-squash branch SHA a workflow still names survives
// only as a dangling object, reachable from no branch. `ci.yml` pinned exactly
// such a commit (ae45f805, a pre-squash commit from #137); nothing detected it.
//
// This scans a repo's workflows for first-party pins — `uses: <owner>/<repo>/
// <path>@<40-hex>` where <owner> is ours — and fails when a pinned SHA is not
// reachable from that target repo's default branch. Same-repo pins are checked
// against local git; cross-repo pins (e.g. every governed repo pinning
// playbook-engineering's ci-policy action) are checked through the compare API,
// which reports whether one commit is an ancestor of another.
//
//   node tools/repos/pin-reachability.mjs [--json] [--owner qwts]
//
// Auth for cross-repo checks: GH_DRIFT_TOKEN or the ambient `gh auth token`
// (same as drift.mjs). Zero-dependency (ENG-0004).

import process from 'node:process';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { api, userToken } from './drift.mjs';

const DEFAULT_OWNER = 'qwts';

// A `uses:` line pinning a first-party action to a full commit SHA. Only 40-hex
// pins are first-party-audited here: a tag or branch ref is a different policy
// (see the SHA-pin doctrine, #4/#5 re-scoped under #107/#156) and is out of
// scope for a *reachability* check, which is meaningful only for a commit.
const FIRST_PARTY_PIN = /^\s*(?:-\s*)?uses:\s*(['"]?)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(\S+?)@([0-9a-f]{40})\1\s*(?:#.*)?$/u;

/**
 * Every first-party pin in a workflow file, as { owner, repo, path, sha, line }.
 * Third-party pins (owner !== ours) are ignored — their reachability is their
 * maintainer's concern, and we cannot audit another org's default branch.
 */
export function extractFirstPartyPins(workflowText, { owner = DEFAULT_OWNER } = {}) {
  const pins = [];
  const lines = workflowText.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const match = FIRST_PARTY_PIN.exec(lines[i]);
    if (!match) continue;
    const [, , pinOwner, repo, path, sha] = match;
    if (pinOwner !== owner) continue;
    pins.push({ owner: pinOwner, repo, path, sha, line: i + 1 });
  }
  return pins;
}

/**
 * The compare API's `status` for `base...head` answers ancestry directly:
 * `identical` (same commit) or `behind` (head is an ancestor of base) mean the
 * pinned head is reachable from base; `ahead` or `diverged` mean it is not.
 * A null response (404/403) is treated as unverifiable, not reachable.
 */
export function isReachableCompareStatus(status) {
  return status === 'identical' || status === 'behind';
}

// Dedupe: the same (repo, sha) is often pinned by several workflows; verify once.
export function uniquePinTargets(pins) {
  const seen = new Map();
  for (const pin of pins) {
    const key = `${pin.owner}/${pin.repo}@${pin.sha}`;
    if (!seen.has(key)) seen.set(key, { owner: pin.owner, repo: pin.repo, sha: pin.sha });
  }
  return [...seen.values()];
}

// `git merge-base --is-ancestor` exits 0 when reachable and 1 when both commits
// are known but the pin is NOT an ancestor (the real dangling-pin case). Any
// other status — 128 for a bad/absent object under a shallow checkout — is not
// evidence of unreachability, so it is reported unverifiable rather than failing
// closed on a missing object.
function localIsAncestor(sha, ref = 'HEAD') {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, ref], { stdio: 'ignore' });
    return true;
  } catch (error) {
    if (error?.status === 1) return false;
    return { unverifiable: true };
  }
}

async function apiReachable(target, token) {
  const meta = await api(`/repos/${target.owner}/${target.repo}`, token);
  const base = meta?.default_branch;
  if (!base) return { unverifiable: true };
  const compare = await api(`/repos/${target.owner}/${target.repo}/compare/${base}...${target.sha}`, token);
  if (compare === null) return { unverifiable: true };
  return isReachableCompareStatus(compare.status);
}

// Resolve reachability for one (owner, repo, sha). Same-repo targets try local
// git first (fast, offline) and fall back to the compare API when local history
// cannot confirm — a shallow CI checkout has no objects, so the local path
// alone would silently pass everything. Cross-repo targets always use the API.
async function reachable(target, { selfOwner, selfRepo, token }) {
  if (target.owner === selfOwner && target.repo === selfRepo) {
    const local = localIsAncestor(target.sha, 'HEAD');
    if (local === true || local === false) return local;
    return apiReachable(target, token);
  }
  return apiReachable(target, token);
}

function workflowFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((name) => name.endsWith('.yml') || name.endsWith('.yaml')).map((name) => join(dir, name));
}

export async function checkPins({ root = process.cwd(), owner = DEFAULT_OWNER, token, selfRepo } = {}) {
  const files = workflowFiles(join(root, '.github', 'workflows'));
  const pinsByTarget = new Map();
  for (const file of files) {
    for (const pin of extractFirstPartyPins(readFileSync(file, 'utf8'), { owner })) {
      const key = `${pin.owner}/${pin.repo}@${pin.sha}`;
      if (!pinsByTarget.has(key)) pinsByTarget.set(key, { ...pin, files: [] });
      pinsByTarget.get(key).files.push(`${file.replace(`${root}/`, '')}:${pin.line}`);
    }
  }
  const findings = [];
  for (const [, pin] of pinsByTarget) {
    const result = await reachable(pin, { selfOwner: owner, selfRepo, token });
    if (result === true) continue;
    findings.push({
      ...pin,
      status: result?.unverifiable ? 'unverifiable' : 'unreachable',
    });
  }
  return findings;
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const ownerArg = args.indexOf('--owner');
  const owner = ownerArg >= 0 ? args[ownerArg + 1] : DEFAULT_OWNER;
  const root = process.cwd();
  // The repo we are running in, so its own pins are checked against local git
  // rather than the API: read it from the git remote.
  let selfRepo;
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    selfRepo = url.replace(/\.git$/u, '').split('/').at(-1);
  } catch {
    selfRepo = undefined;
  }
  const token = userToken();
  const findings = await checkPins({ root, owner, token, selfRepo });
  if (asJson) {
    process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
  } else if (findings.length === 0) {
    process.stdout.write('all first-party action pins are reachable from their default branch\n');
  } else {
    for (const f of findings) {
      process.stdout.write(
        `${f.status === 'unverifiable' ? 'WARN ' : 'FAIL '}${f.owner}/${f.repo}/${f.path}@${f.sha} ` +
          `(${f.status}) — pinned in ${f.files.join(', ')}\n`,
      );
    }
  }
  // Unreachable pins fail the check; unverifiable ones (network/visibility) warn
  // but do not, so a token without cross-repo read cannot mask a real dangling pin.
  process.exit(findings.some((f) => f.status === 'unreachable') ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

export { DEFAULT_OWNER };
