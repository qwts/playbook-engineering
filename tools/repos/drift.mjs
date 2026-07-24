#!/usr/bin/env node
// Governance drift detector (issue #38, phase 1 — read-only).
// Compares every repo in governance/repos.json against live GitHub:
//
//   - baseline files per the repo-baseline-files SOP
//   - a default-branch rule requiring at least one approving review
//     (rulesets or classic branch protection)
//   - private vulnerability reporting enabled
//   - all four agent-App installations (ENG-0016)
//
// Repos with status "active" are expected to conform — their drift sets the
// exit code, so CI can gate on it. Status "onboarding" repos report drift
// without failing: declared, not yet conformant. Zero-dependency (ENG-0004).
//
//   node tools/repos/drift.mjs [--json]
//
// Auth: a token with read access to the governed repos — GH_DRIFT_TOKEN, or
// the ambient `gh auth token`. App coverage is queried with each App's own
// installation token via tools/agent-bot (needs the per-App keys under
// ~/.config/<slug>/).

import process from 'node:process';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mint } from '../agent-bot/mint-token.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const APPS = ['qwts-claude-agent', 'qwts-codex-agent', 'qwts-cursor-agent', 'qwts-vscode-agent'];
export const BASELINE_FILES = ['README.md', 'LICENSE', 'AGENTS.md', 'CONTRIBUTING.md', '.github/CODEOWNERS'];

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
export async function appCoverage() {
  const coverage = {};
  for (const slug of APPS) {
    const { token } = await mint({ slug });
    const names = new Set();
    for (let page = 1; ; page += 1) {
      const batch = await api(`/installation/repositories?per_page=100&page=${page}`, token);
      for (const repo of batch?.repositories ?? []) names.add(repo.name);
      if (!batch || batch.repositories.length < 100) break;
    }
    coverage[slug] = names;
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
  for (const slug of APPS) checks[`app: ${slug}`] = coverage[slug].has(entry.name);

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
