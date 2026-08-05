#!/usr/bin/env node
// Governance reconciler (issue #38, phase 2 — apply). One operation converges
// a repo — new, existing, or migrating — toward the manifest. Decision record:
// docs/decisions/ENG-0038-governance-reconciler.md.
//
//   node tools/repos/reconcile.mjs [--repo <name>] [--apply] [--json]
//   node tools/repos/reconcile.mjs --promote <onboarding-repo>
//
// Dry-run by default: prints each repo's plan and touches nothing. --apply
// executes the automatable lanes and always reprints the human lane:
//
//   settings — via the human's ambient token (rulesets and repo settings need
//              admin, which no App on a user account has): bump the ruleset's
//              review count to 1 (creating the owner-aware standard ruleset if
//              none while preserving enabled merge methods), and
//              enable private vulnerability reporting.
//   seeds    — missing baseline files, proposed as a bot-authored PR to the
//              target repo (never a direct push): AGENTS.md, CONTRIBUTING.md,
//              CODEOWNERS, the shared .codex environment, and the shared
//              feature issue form. Only missing files are added — existing
//              content is never clobbered.
//   projection — the marked shared discovery block in an existing AGENTS.md,
//              proposed on the same bot-authored PR without changing local
//              agent context outside that block.
//   human    — printed, never attempted: repo creation, App installations,
//              README/LICENSE (deliberately per-repo).
//
// Run from this checkout — templates under governance/baseline/ resolve
// against it (the playbook is the governance source of truth).

import process from 'node:process';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkRepo, appCoverage, contentSource, userToken, api } from './drift.mjs';
import { plan, promotionPlan, bumpReviewCount, canUseMergeQueue, defaultRuleset } from './lib/reconcile-plan.mjs';
import { mintAgentToken } from './lib/agent-bot-client.mjs';
import { loadCanonicalDiscoveryBlock, projectDiscoveryBlock } from './lib/agent-context-discovery.mjs';

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
        const meta = await call('GET', `/repos/${owner}/${name}`, token);
        const allowedMergeMethods = [
          ...(meta.allow_merge_commit ? ['merge'] : []),
          ...(meta.allow_squash_merge ? ['squash'] : []),
          ...(meta.allow_rebase_merge ? ['rebase'] : []),
        ];
        if (allowedMergeMethods.length === 0) {
          throw new Error(`${owner}/${name}: repository has no enabled pull-request merge method`);
        }
        const ownerPlan = meta.owner?.type === 'Organization' && meta.visibility !== 'public'
          ? (await call('GET', `/orgs/${owner}`, token)).plan?.name
          : undefined;
        await call('POST', `/repos/${owner}/${name}/rulesets`, token, defaultRuleset({
          mergeQueueAvailable: canUseMergeQueue({
            ownerType: meta.owner?.type,
            visibility: meta.visibility,
            ownerPlan,
          }),
          allowedMergeMethods,
        }));
        done.push('ruleset "Default" created (review count 1)');
      }
    }
  }
  return done;
}

function encodedPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function putFile(owner, name, target, content, message, branch, token) {
  const existing = await api(`/repos/${owner}/${name}/contents/${encodedPath(target)}?ref=${encodeURIComponent(branch)}`, token);
  if (existing && contentSource(existing) === content) return false;
  await call('PUT', `/repos/${owner}/${name}/contents/${encodedPath(target)}`, token, {
    message,
    content: Buffer.from(content).toString('base64'),
    branch,
    ...(existing?.sha ? { sha: existing.sha } : {}),
  });
  return true;
}

async function applyBaseline(owner, name, seeds, projections, botToken) {
  const meta = await call('GET', `/repos/${owner}/${name}`, botToken);
  const base = meta.default_branch;
  const open = await call('GET', `/repos/${owner}/${name}/pulls?head=${owner}:${SEED_BRANCH}&state=open`, botToken);
  if (open.length === 0) {
    const head = await call('GET', `/repos/${owner}/${name}/git/ref/${encodeURIComponent(`heads/${base}`)}`, botToken);
    try {
      await call('POST', `/repos/${owner}/${name}/git/refs`, botToken, {
        ref: `refs/heads/${SEED_BRANCH}`,
        sha: head.object.sha,
      });
    } catch (err) {
      if (!/422/.test(err.message)) throw err; // branch left over without a PR: reuse it
    }
  }

  const changed = [];
  for (const seed of seeds) {
    const content = readFileSync(join(ROOT, seed.source), 'utf8');
    if (await putFile(owner, name, seed.target, content, `governance: seed ${seed.target} from the repo-baseline-files SOP`, SEED_BRANCH, botToken)) {
      changed.push(`seeded ${seed.target}`);
    }
  }
  if (projections.some((projection) => projection.target === 'AGENTS.md')) {
    const target = 'AGENTS.md';
    const current = await api(`/repos/${owner}/${name}/contents/${target}?ref=${encodeURIComponent(SEED_BRANCH)}`, botToken);
    if (!current) throw new Error(`${owner}/${name}: cannot project shared discovery into a missing AGENTS.md`);
    const next = projectDiscoveryBlock(contentSource(current), loadCanonicalDiscoveryBlock(ROOT));
    if (await putFile(owner, name, target, next, 'governance: project shared agent-context discovery', SEED_BRANCH, botToken)) {
      changed.push('projected shared agent-context discovery');
    }
  }

  const pullAction = reconciliationPullAction({
    hasOpenPull: open.length > 0,
    changed: changed.length > 0,
  });
  if (pullAction !== 'open') {
    return `${pullAction === 'update' ? 'reconciliation PR updated' : 'reconciliation PR already current'}: ${open[0].html_url}`;
  }
  const pr = await call('POST', `/repos/${owner}/${name}/pulls`, botToken, {
    title: 'governance: reconcile baseline files',
    head: SEED_BRANCH,
    base,
    body:
      `Reconciles baseline files and the shared agent-context discovery block, per the ` +
      `[repo-baseline-files SOP](https://github.com/${owner}/playbook-engineering/blob/main/docs/sop/repo-baseline-files.md) ` +
      `and [ENG-0038](https://github.com/${owner}/playbook-engineering/blob/main/docs/decisions/ENG-0038-governance-reconciler.md). ` +
      `Only missing baseline files are seeded; an existing AGENTS.md receives only the marked shared discovery block and retains repository-specific context. ` +
      `Generated by \`node tools/repos/reconcile.mjs --apply\`.`,
  });
  return `reconciliation PR opened: ${pr.html_url}`;
}

function optionValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a repository name`);
  return value;
}

export function parseReconcileArgs(argv) {
  const apply = argv.includes('--apply');
  const only = optionValue(argv, '--repo');
  const promote = optionValue(argv, '--promote');
  if (apply && promote !== null) throw new Error('--apply and --promote cannot be used together');
  return { apply, only, promote };
}

export function reconciliationPullAction({ hasOpenPull, changed }) {
  if (!hasOpenPull) return 'open';
  return changed ? 'update' : 'current';
}

async function main() {
  const argv = process.argv;
  const { apply, only, promote } = parseReconcileArgs(argv);

  const manifest = JSON.parse(readFileSync(join(ROOT, 'governance', 'repos.json'), 'utf8'));
  if (promote) {
    const entry = manifest.repos.find((repo) => repo.name === promote);
    if (!entry) throw new Error(`--promote ${promote}: not a manifest entry`);
    if (entry.status !== 'onboarding') throw new Error(`--promote ${promote}: only onboarding repositories can be promoted`);

    const token = userToken();
    const coverage = await appCoverage();
    const result = await checkRepo(manifest.account, entry, coverage, token);
    const gate = promotionPlan(result);
    if (!gate.eligible) {
      throw new Error(`${entry.name} remains onboarding; promotion blocked by: ${gate.reasons.join(', ')}`);
    }
    entry.status = 'active';
    writeFileSync(join(ROOT, 'governance', 'repos.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    execFileSync(process.execPath, [join(ROOT, 'tools', 'repos', 'repos.mjs'), '--write'], { cwd: ROOT, stdio: 'inherit' });
    process.stdout.write(`${entry.name} promoted to active after a conformant live audit\n`);
    return;
  }
  const entries = manifest.repos.filter(
    (r) => (r.status === 'active' || r.status === 'onboarding') && (!only || r.name === only),
  );
  if (only && entries.length === 0) throw new Error(`--repo ${only}: not an active/onboarding manifest entry`);

  const token = userToken();
  const coverage = await appCoverage();
  let botToken;

  const report = [];
  for (const entry of entries) {
    const p = plan(await checkRepo(manifest.account, entry, coverage, token));
    const line = { ...p, applied: [] };
    if (apply) {
      if (p.settings.length) line.applied.push(...(await applySettings(manifest.account, entry.name, p.settings, token)));
      if (p.seeds.length || p.projections.length) {
        botToken ??= mintAgentToken().token;
        const accessible = await api(`/repos/${manifest.account}/${entry.name}`, botToken);
        if (!accessible) line.human.push('reconciliation PR skipped: the resolved agent App is not installed on this repository');
        else line.applied.push(await applyBaseline(manifest.account, entry.name, p.seeds, p.projections, botToken));
      }
    }
    report.push(line);
  }

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  for (const r of report) {
    const clean = !r.settings.length && !r.seeds.length && !r.projections.length && !r.human.length;
    process.stdout.write(`${r.name} (${r.status})${clean ? ' — conformant' : ''}\n`);
    for (const s of r.settings) process.stdout.write(`  settings: ${s.action} (${s.check})\n`);
    for (const s of r.seeds) process.stdout.write(`  seed: ${s.target}\n`);
    for (const p of r.projections) process.stdout.write(`  project: ${p.target} (${p.action})\n`);
    for (const h of r.human) process.stdout.write(`  human: ${h}\n`);
    for (const a of r.applied) process.stdout.write(`  applied: ${a}\n`);
  }
  if (!apply) process.stdout.write('\ndry run — pass --apply to converge the settings, seeds, and projection lanes\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`reconcile: ${err.message}`);
    process.exit(1);
  });
}
