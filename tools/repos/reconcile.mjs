#!/usr/bin/env node
// Governance reconciler (issue #38, phase 2 — apply). One operation converges
// a repo — new, existing, or migrating — toward the manifest. Decision record:
// docs/decisions/ENG-0038-governance-reconciler.md.
//
//   node tools/repos/reconcile.mjs [--repo <name>] [--apply] [--json]
//
// Dry-run by default: prints each repo's plan and touches nothing. --apply
// executes the two automatable lanes and always reprints the human lane:
//
//   settings — via the human's ambient token (rulesets and repo settings need
//              admin, which no App on a user account has): bump the ruleset's
//              review count to 1 (creating the standard ruleset if none), and
//              enable private vulnerability reporting.
//   seeds    — missing baseline files, proposed as a bot-authored PR to the
//              target repo (never a direct push): AGENTS.md, CONTRIBUTING.md,
//              CODEOWNERS, and the shared feature issue form. Only missing
//              files are added — existing content is never clobbered.
//   human    — printed, never attempted: repo creation, App installations,
//              README/LICENSE (deliberately per-repo).
//
// Run from this checkout — templates under governance/baseline/ resolve
// against it (the playbook is the runtime source of truth).

import process from 'node:process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkRepo, appCoverage, userToken, api } from './drift.mjs';
import { plan, bumpReviewCount, defaultRuleset } from './lib/reconcile-plan.mjs';
import { mint } from '../agent-bot/mint-token.mjs';
import { detectHarness } from '../agent-bot/detect-harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEED_BRANCH = 'governance/baseline-seed';

async function call(method, path, token, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'qwts-governance-reconcile',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${data.message ?? 'unknown error'}`);
  return data;
}

async function applySettings(owner, name, actions, token) {
  const done = [];
  for (const { action } of actions) {
    if (action === 'enable-pvr') {
      await call('PUT', `/repos/${owner}/${name}/private-vulnerability-reporting`, token);
      done.push('private vulnerability reporting enabled');
    }
    if (action === 'ruleset-review-count') {
      const rulesets = (await api(`/repos/${owner}/${name}/rulesets`, token)) ?? [];
      let updated = false;
      for (const summary of rulesets) {
        const rs = await api(`/repos/${owner}/${name}/rulesets/${summary.id}`, token);
        const payload = rs && bumpReviewCount(rs);
        if (payload) {
          await call('PUT', `/repos/${owner}/${name}/rulesets/${rs.id}`, token, payload);
          done.push(`ruleset "${rs.name}": review count >= 1`);
          updated = true;
          break;
        }
      }
      if (!updated) {
        await call('POST', `/repos/${owner}/${name}/rulesets`, token, defaultRuleset());
        done.push('ruleset "Default" created (review count 1)');
      }
    }
  }
  return done;
}

async function applySeeds(owner, name, seeds, botToken) {
  const meta = await call('GET', `/repos/${owner}/${name}`, botToken);
  const base = meta.default_branch;
  const open = await call('GET', `/repos/${owner}/${name}/pulls?head=${owner}:${SEED_BRANCH}&state=open`, botToken);
  if (open.length > 0) return `seed PR already open: ${open[0].html_url}`;

  const head = await call('GET', `/repos/${owner}/${name}/git/ref/${encodeURIComponent(`heads/${base}`)}`, botToken);
  try {
    await call('POST', `/repos/${owner}/${name}/git/refs`, botToken, {
      ref: `refs/heads/${SEED_BRANCH}`,
      sha: head.object.sha,
    });
  } catch (err) {
    if (!/422/.test(err.message)) throw err; // branch left over without a PR: reuse it
  }
  for (const seed of seeds) {
    const content = readFileSync(join(ROOT, seed.source), 'utf8');
    await call('PUT', `/repos/${owner}/${name}/contents/${seed.target.split('/').map(encodeURIComponent).join('/')}`, botToken, {
      message: `governance: seed ${seed.target} from the repo-baseline-files SOP`,
      content: Buffer.from(content).toString('base64'),
      branch: SEED_BRANCH,
    });
  }
  const pr = await call('POST', `/repos/${owner}/${name}/pulls`, botToken, {
    title: 'governance: seed missing baseline files',
    head: SEED_BRANCH,
    base,
    body:
      `Seeds the baseline files the drift detector found missing, per the ` +
      `[repo-baseline-files SOP](https://github.com/${owner}/playbook-engineering/blob/main/docs/sop/repo-baseline-files.md) ` +
      `and [ENG-0038](https://github.com/${owner}/playbook-engineering/blob/main/docs/decisions/ENG-0038-governance-reconciler.md). ` +
      `Only missing files are added; nothing existing is touched. ` +
      `Generated by \`node tools/repos/reconcile.mjs --apply\`.`,
  });
  return `seed PR opened: ${pr.html_url}`;
}

async function main() {
  const argv = process.argv;
  const apply = argv.includes('--apply');
  const only = argv.includes('--repo') ? argv[argv.indexOf('--repo') + 1] : null;

  const manifest = JSON.parse(readFileSync(join(ROOT, 'governance', 'repos.json'), 'utf8'));
  const entries = manifest.repos.filter(
    (r) => (r.status === 'active' || r.status === 'onboarding') && (!only || r.name === only),
  );
  if (only && entries.length === 0) throw new Error(`--repo ${only}: not an active/onboarding manifest entry`);

  const token = userToken();
  const coverage = await appCoverage();
  const slug = detectHarness(process.env);

  const report = [];
  for (const entry of entries) {
    const p = plan(await checkRepo(manifest.account, entry, coverage, token));
    const line = { ...p, applied: [] };
    if (apply) {
      if (p.settings.length) line.applied.push(...(await applySettings(manifest.account, entry.name, p.settings, token)));
      if (p.seeds.length) {
        if (!slug) line.human.push('seed PR skipped: no harness detected — set GH_AGENT_APP or run from an agent session');
        else if (!coverage[slug]?.has(entry.name)) line.human.push(`seed PR skipped: ${slug} is not installed on ${entry.name}`);
        else line.applied.push(await applySeeds(manifest.account, entry.name, p.seeds, (await mint({ slug })).token));
      }
    }
    report.push(line);
  }

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  for (const r of report) {
    const clean = !r.settings.length && !r.seeds.length && !r.human.length;
    process.stdout.write(`${r.name} (${r.status})${clean ? ' — conformant' : ''}\n`);
    for (const s of r.settings) process.stdout.write(`  settings: ${s.action} (${s.check})\n`);
    for (const s of r.seeds) process.stdout.write(`  seed: ${s.target}\n`);
    for (const h of r.human) process.stdout.write(`  human: ${h}\n`);
    for (const a of r.applied) process.stdout.write(`  applied: ${a}\n`);
  }
  if (!apply) process.stdout.write('\ndry run — pass --apply to converge the settings and seeds lanes\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`reconcile: ${err.message}`);
    process.exit(1);
  });
}
