#!/usr/bin/env node
// Governance drift detector (issue #38, phase 1 — read-only).
// Compares every repo in governance/repos.json against live GitHub:
//
//   - baseline files per the repo-baseline-files SOP
//   - a default-branch rule requiring at least one approving review
//     (rulesets or classic branch protection)
//   - private vulnerability reporting enabled
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
import { activeAgentSlugs, loadAgents, validateAgents } from './lib/agents.mjs';
import { mintAgentToken } from './lib/agent-bot-client.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
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

async function reviewRequired(owner, name, branch, token) {
  const rules = (await api(`/repos/${owner}/${name}/rules/branches/${branch}`, token)) ?? [];
  const rule = rules.find((r) => r.type === 'pull_request');
  if ((rule?.parameters?.required_approving_review_count ?? 0) >= 1) return true;
  const classic = await api(`/repos/${owner}/${name}/branches/${branch}/protection`, token);
  return (classic?.required_pull_request_reviews?.required_approving_review_count ?? 0) >= 1;
}

export async function checkRepo(owner, entry, coverage, token) {
  // The coverage map's own keys are the roster: one entry per App listed.
  const checks = {};
  const meta = await api(`/repos/${owner}/${entry.name}`, token);
  if (!meta) return { name: entry.name, status: entry.status, error: 'repo not found or not visible' };

  for (const file of BASELINE_FILES) {
    const path = file.split('/').map(encodeURIComponent).join('/');
    checks[file] = (await api(`/repos/${owner}/${entry.name}/contents/${path}`, token)) !== null;
  }
  const templates = await api(`/repos/${owner}/${entry.name}/contents/.github/ISSUE_TEMPLATE`, token);
  checks['feature issue template'] = Array.isArray(templates) && templates.some((t) => /feature/i.test(t.name));
  checks['review required to merge'] = await reviewRequired(owner, entry.name, meta.default_branch, token);
  const pvr = await api(`/repos/${owner}/${entry.name}/private-vulnerability-reporting`, token);
  checks['private vulnerability reporting'] = pvr?.enabled === true;
  for (const slug of Object.keys(coverage)) checks[`app: ${slug}`] = coverage[slug].has(entry.name);

  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  return { name: entry.name, status: entry.status, checks, failed };
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
    }
  }

  const activeDrift = results.filter((r) => r.status === 'active' && (r.error || r.failed.length));
  process.stdout.write(
    activeDrift.length
      ? `\ndrift in ${activeDrift.length} active repo(s): ${activeDrift.map((r) => r.name).join(', ')}\n`
      : '\nall active repos conform\n',
  );
  process.exitCode = activeDrift.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`drift: ${err.message}`);
    process.exit(1);
  });
}
