#!/usr/bin/env node
// Governance drift detector (issue #38, phase 1 — read-only).
// Compares every repo in governance/repos.json against live GitHub:
//
//   - baseline files per the repo-baseline-files SOP
//   - a default-branch rule requiring at least one approving review
//     (rulesets or classic branch protection)
//   - private vulnerability reporting enabled
//   - CodeQL running from the repo's own workflow, not GitHub's default setup
//   - installation of every active agent App in governance/agents.json
//     (ENG-0016, ENG-0079 — the roster is data, so the count is not fixed)
//
// Repos with status "active" are expected to conform — their drift sets the
// exit code, so CI can gate on it. Status "onboarding" repos report drift
// without failing: declared, not yet conformant. Zero-dependency (ENG-0004).
//
//   node tools/repos/drift.mjs [--json]
//
// Auth: a token with read access to the governed repos — GH_DRIFT_TOKEN, or
// the ambient `gh auth token`. App coverage is queried with each App's own
// installation token via the installed agent-bot CLI (needs the per-App keys
// under ~/.config/<slug>/).

import process from 'node:process';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BASELINE_FILES } from './lib/baseline-files.mjs';
import {
  DISCOVERY_CHECK,
  discoveryDisposition,
  loadCanonicalDiscoveryBlock,
} from './lib/agent-context-discovery.mjs';
import { activeAgentSlugs, loadAgents, validateAgents } from './lib/agents.mjs';
import { mintAgentToken } from './lib/agent-bot-client.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CANONICAL_DISCOVERY_BLOCK = loadCanonicalDiscoveryBlock(ROOT);
export { BASELINE_FILES };

// The Apps to verify come from the roster, not from a constant here: an
// identity added to governance/agents.json is checked with no code change,
// and one that is never registered is one nothing watches (ENG-0079).
export function apps(root = ROOT) {
  const roster = loadAgents(join(root, 'governance', 'agents.json'));
  const errors = validateAgents(roster);
  if (errors.length > 0) {
    throw new Error(`governance/agents.json is invalid:\n  - ${errors.join('\n  - ')}`);
  }
  return activeAgentSlugs(roster);
}

export function userToken() {
  if (process.env.GH_DRIFT_TOKEN) return process.env.GH_DRIFT_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('no GitHub token — set GH_DRIFT_TOKEN, or install and authenticate the gh CLI (gh auth login)');
  }
}

export async function api(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'qwts-governance-drift',
    },
  });
  if (res.status === 404 || res.status === 403) return null; // absent or not visible = not conformant
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

export function contentSource(file) {
  if (typeof file?.content !== 'string') return '';
  return Buffer.from(file.content, 'base64').toString('utf8');
}

// One installation-repository listing per App; every repo check reads the set.
export async function installationRepositories(
  slug,
  { mintToken = mintAgentToken, apiCall = api } = {},
) {
  const { token } = mintToken({ slug });
  const names = new Set();
  for (let page = 1; ; page += 1) {
    const batch = await apiCall(`/installation/repositories?per_page=100&page=${page}`, token);
    for (const repo of batch?.repositories ?? []) names.add(repo.name);
    if (!batch || batch.repositories.length < 100) return names;
  }
}

export async function appCoverage(slugs = apps(), dependencies) {
  const coverage = {};
  for (const slug of slugs) {
    coverage[slug] = await installationRepositories(slug, dependencies);
  }
  return coverage;
}

// Which CodeQL setup produced a repo's analyses, read from the marker GitHub
// stamps on each one. Default setup runs as the unselectable
// github-advanced-security[bot] actor and reports `analysis_key` under
// `dynamic/github-code-scanning/`; a workflow-driven run carries its own
// workflow path instead. That distinction is the whole point — the fleet uses
// advanced setup so code scanning stays inside the repository Actions Policy.
//
// Deliberately not a scan of `.github/workflows/` for `github/codeql-action`.
// Two reasons, both learned the hard way in bookmarkit:
//
//   1. A file is not a producer. bookmarkit carried CodeQL as a *required*
//      status check with nothing behind it for two days; PR #121 was green,
//      approved and fully signed, and still had to be merged with --admin. A
//      contents scan reports on intent; analyses report on what happened.
//   2. Matching source text is a heuristic in both directions — a reusable
//      workflow whose path avoids the word "codeql" is invisible, and a comment
//      mentioning codeql-action over-matches.
export function codeqlSetupFrom(analyses) {
  if (!Array.isArray(analyses)) return null; // unreadable — never a guessed "none"
  const keys = [];
  for (const analysis of analyses) {
    // The endpoint returns every tool's uploads, not CodeQL's. A repo pushing
    // Semgrep or Trivy SARIF carries an analysis_key that is not GitHub's
    // default-setup marker, which would read as an advanced CodeQL setup and
    // pass this gate with no CodeQL anywhere. The request also asks for
    // tool_name=CodeQL; this filter is what makes the classifier correct on its
    // own rather than only when its caller remembers the parameter.
    const tool = analysis?.tool?.name;
    if (typeof tool !== 'string') return null; // a shape we do not understand
    if (tool !== 'CodeQL') continue;
    if (typeof analysis.analysis_key !== 'string') return null;
    keys.push(analysis.analysis_key);
  }
  if (keys.length === 0) return 'none';
  // A repo mid-migration can carry both; advanced wins as the superset.
  return keys.some((k) => !k.startsWith('dynamic/github-code-scanning/')) ? 'advanced' : 'default';
}

// Six hours. Long enough that a merge landing mid-run is not reported as drift
// while its CI is still going; short enough that a workflow which stopped
// running is caught the same day.
export const CODEQL_GRACE_MS = 6 * 60 * 60 * 1000;

// Whether the newest CodeQL analysis actually covers the current default-branch
// head. Classification alone is not enough: GitHub keeps historical analyses
// forever, so a repo whose workflow is deleted, disabled, or silently stops
// uploading keeps reporting 'advanced' off runs from weeks ago. That is the same
// went-dark failure this check exists to catch, just slower to notice.
export function codeqlFreshness({ analyses, headSha, headCommittedAt, now, graceMs = CODEQL_GRACE_MS }) {
  if (!Array.isArray(analyses) || typeof headSha !== 'string' || !headSha) return null;
  const dated = analyses
    .filter((a) => a?.tool?.name === 'CodeQL' && typeof a?.commit_sha === 'string')
    .map((a) => ({ sha: a.commit_sha, at: Date.parse(a.created_at) }))
    .filter((a) => Number.isFinite(a.at));
  if (dated.length === 0) return null;
  // Sorted rather than trusting the endpoint's order: relying on an undocumented
  // ordering would fail silently and look like staleness.
  const newest = dated.reduce((a, b) => (b.at > a.at ? b : a));
  if (newest.sha === headSha) return 'current';
  // The head moved and this analysis is for an older commit. That is only drift
  // once CI has had time to run — otherwise every repo is briefly "stale" in the
  // minutes after a merge.
  const headAt = Date.parse(headCommittedAt ?? '');
  if (!Number.isFinite(headAt) || !Number.isFinite(now)) return null;
  return now - headAt < graceMs ? 'current' : 'stale';
}

async function reviewRequired(owner, name, branch, token) {
  const rules = (await api(`/repos/${owner}/${name}/rules/branches/${branch}`, token)) ?? [];
  const rule = rules.find((r) => r.type === 'pull_request');
  if ((rule?.parameters?.required_approving_review_count ?? 0) >= 1) return true;
  const classic = await api(`/repos/${owner}/${name}/branches/${branch}/protection`, token);
  return (classic?.required_pull_request_reviews?.required_approving_review_count ?? 0) >= 1;
}

export async function checkRepo(owner, entry, coverage, token, {
  canonicalDiscoveryBlock = CANONICAL_DISCOVERY_BLOCK,
} = {}) {
  // The coverage map's own keys are the roster: one entry per App listed.
  const checks = {};
  const meta = await api(`/repos/${owner}/${entry.name}`, token);
  if (!meta) return { name: entry.name, status: entry.status, error: 'repo not found or not visible' };

  let agentContext;
  for (const file of BASELINE_FILES) {
    const path = file.split('/').map(encodeURIComponent).join('/');
    const contents = await api(`/repos/${owner}/${entry.name}/contents/${path}`, token);
    checks[file] = contents !== null;
    if (file === 'AGENTS.md') agentContext = contents;
  }
  const discovery = discoveryDisposition(entry.status, contentSource(agentContext), canonicalDiscoveryBlock);
  checks[DISCOVERY_CHECK] = discovery.conformant;
  const templates = await api(`/repos/${owner}/${entry.name}/contents/.github/ISSUE_TEMPLATE`, token);
  checks['feature issue template'] = Array.isArray(templates) && templates.some((t) => /feature/i.test(t.name));
  checks['review required to merge'] = await reviewRequired(owner, entry.name, meta.default_branch, token);
  const pvr = await api(`/repos/${owner}/${entry.name}/private-vulnerability-reporting`, token);
  checks['private vulnerability reporting'] = pvr?.enabled === true;
  // Pinned to the default branch: analyses are recorded against PR refs too, so
  // an unpinned read measures pull-request traffic rather than the repo's
  // steady state. `api` collapses 403 and 404 to null, so an unreadable repo
  // and one that has never scanned both land as non-conformant — fail closed,
  // which is the right default for a gate.
  const analyses = await api(
    `/repos/${owner}/${entry.name}/code-scanning/analyses?per_page=20&tool_name=CodeQL&ref=refs/heads/${encodeURIComponent(meta.default_branch)}`,
    token,
  );
  const head = await api(
    `/repos/${owner}/${entry.name}/commits/${encodeURIComponent(meta.default_branch)}`,
    token,
  );
  // Both halves, in one check: a repo can fail either by never scanning with its
  // own workflow or by having stopped. Splitting them would make a repo with no
  // CodeQL at all report two failures for one problem, and would force the
  // freshness line into a vacuous pass whenever there was nothing to be stale.
  checks['code scanning (CodeQL, own workflow, current)'] =
    codeqlSetupFrom(analyses) === 'advanced' &&
    codeqlFreshness({
      analyses,
      headSha: head?.sha,
      headCommittedAt: head?.commit?.committer?.date,
      now: Date.now(),
    }) === 'current';
  for (const slug of Object.keys(coverage)) checks[`app: ${slug}`] = coverage[slug].has(entry.name);

  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  return { name: entry.name, status: entry.status, checks, failed, discovery };
}

export function activeDrift(results) {
  return results.filter((r) => r.status === 'active' && (r.error || r.failed.length));
}

async function main() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'governance', 'repos.json'), 'utf8'));
  const token = userToken();
  const coverage = await appCoverage();
  const repos = manifest.repos.filter((r) => r.status === 'active' || r.status === 'onboarding');

  const results = [];
  for (const entry of repos) results.push(await checkRepo(manifest.account, entry, coverage, token));

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    for (const r of results) {
      if (r.error) {
        process.stdout.write(`${r.name} (${r.status}) — ERROR: ${r.error}\n`);
        continue;
      }
      const total = Object.keys(r.checks).length;
      const passed = total - r.failed.length;
      process.stdout.write(`${r.name} (${r.status}) — ${passed}/${total}\n`);
      for (const miss of r.failed) process.stdout.write(`  ✗ ${miss}\n`);
      if (r.discovery?.state === 'migration') {
        process.stdout.write('  ↳ migration: shared agent-context discovery is incomplete; promotion to active remains blocked\n');
      }
    }
  }

  const blocking = activeDrift(results);
  process.stdout.write(
    blocking.length
      ? `\ndrift in ${blocking.length} active repo(s): ${blocking.map((r) => r.name).join(', ')}\n`
      : '\nall active repos conform\n',
  );
  process.exitCode = blocking.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`drift: ${err.message}`);
    process.exit(1);
  });
}
