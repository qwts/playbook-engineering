import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  plan,
  bumpReviewCount,
  canUseMergeQueue,
  defaultRuleset,
  mergeQueueRule,
  SEEDS,
} from '../lib/reconcile-plan.mjs';
import { baselineSeedContent, parseReconcileArgs, reconciliationPullAction } from '../reconcile.mjs';
import { BASELINE_FILES, GOVERNED_CODEX_FILES, GOVERNED_HARNESS_FILES } from '../lib/baseline-files.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('a fully conformant repo plans nothing', () => {
  const p = plan({ name: 'clean', status: 'active', failed: [] });
  assert.deepEqual([p.settings, p.seeds, p.human], [[], [], []]);
});

test('promote requires a repository operand and never falls through to apply', () => {
  assert.throws(
    () => parseReconcileArgs(['node', 'reconcile.mjs', '--promote']),
    /--promote requires a repository name/,
  );
  assert.throws(
    () => parseReconcileArgs(['node', 'reconcile.mjs', '--apply', '--promote']),
    /--promote requires a repository name/,
  );
  assert.throws(
    () => parseReconcileArgs(['node', 'reconcile.mjs', '--apply', '--promote', 'localnotes']),
    /--apply and --promote cannot be used together/,
  );
});

test('a recovered reconciliation branch without an open PR always opens one', () => {
  assert.equal(reconciliationPullAction({ hasOpenPull: false, changed: false }), 'open');
  assert.equal(reconciliationPullAction({ hasOpenPull: false, changed: true }), 'open');
  assert.equal(reconciliationPullAction({ hasOpenPull: true, changed: false }), 'current');
  assert.equal(reconciliationPullAction({ hasOpenPull: true, changed: true }), 'update');
});

test('failed checks route to the right lane', () => {
  const p = plan({
    name: 'messy',
    status: 'onboarding',
    failed: [
      'review required to merge',
      'private vulnerability reporting',
      'AGENTS.md',
      '.codex/config.toml',
      'feature issue template',
      'LICENSE',
      'app: qwts-codex-agent',
    ],
  });
  assert.deepEqual(
    p.settings.map((s) => s.action),
    ['ruleset-review-count', 'enable-pvr'],
  );
  assert.deepEqual(
    p.seeds.map((s) => s.target),
    ['AGENTS.md', '.codex/config.toml', '.github/ISSUE_TEMPLATE/feature.yml'],
  );
  assert.equal(p.human.length, 2); // LICENSE decision + App install
  assert.match(p.human.join('\n'), /LICENSE/);
  assert.match(p.human.join('\n'), /qwts-codex-agent/);
});

test('a missing repo is a single human bootstrap step', () => {
  const p = plan({ name: 'ghost', status: 'onboarding', error: 'repo not found or not visible' });
  assert.equal(p.settings.length + p.seeds.length, 0);
  assert.match(p.human[0], /create the repo/);
});

test('an unknown check never plans an automatic action', () => {
  const p = plan({ name: 'r', status: 'active', failed: ['some future check'] });
  assert.equal(p.settings.length + p.seeds.length, 0);
  assert.match(p.human[0], /no reconcile lane/);
});

test('bumpReviewCount raises only the pull_request rule, preserving the rest', () => {
  const rs = {
    name: 'Default',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
    rules: [
      { type: 'deletion' },
      { type: 'pull_request', parameters: { required_approving_review_count: 0, allowed_merge_methods: ['merge'] } },
      { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true } },
    ],
  };
  const out = bumpReviewCount(rs);
  const pr = out.rules.find((r) => r.type === 'pull_request');
  assert.equal(pr.parameters.required_approving_review_count, 1);
  assert.equal(pr.parameters.allowed_merge_methods[0], 'merge'); // sibling params survive
  assert.deepEqual(out.rules[0], { type: 'deletion' }); // other rules untouched
  assert.equal(out.bypass_actors[0].actor_id, 5);
});

test('bumpReviewCount never lowers an already-stricter count', () => {
  const out = bumpReviewCount({
    name: 'strict',
    rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 2 } }],
  });
  assert.equal(out.rules[0].parameters.required_approving_review_count, 2);
});

test('a ruleset without a pull_request rule is not bumpable', () => {
  assert.equal(bumpReviewCount({ name: 'x', rules: [{ type: 'deletion' }] }), null);
});

test('merge queue entitlement accounts for owner, visibility, and organization plan', () => {
  assert.equal(canUseMergeQueue({ ownerType: 'User', visibility: 'public' }), false);
  assert.equal(canUseMergeQueue({ ownerType: 'Organization', visibility: 'public' }), true);
  assert.equal(canUseMergeQueue({ ownerType: 'Organization', visibility: 'private', ownerPlan: 'team' }), false);
  assert.equal(canUseMergeQueue({
    ownerType: 'Organization',
    visibility: 'private',
    ownerPlan: 'enterprise',
  }), true);
});

test('the user-owned default ruleset preserves merge methods without an unavailable queue', () => {
  const rs = defaultRuleset({ allowedMergeMethods: ['merge', 'rebase'] });
  const pr = rs.rules.find((r) => r.type === 'pull_request');
  const queue = rs.rules.find((r) => r.type === 'merge_queue');
  assert.equal(pr.parameters.required_approving_review_count, 1);
  assert.deepEqual(pr.parameters.allowed_merge_methods, ['merge', 'rebase']);
  assert.equal(queue, undefined);
  assert.equal(rs.bypass_actors[0].actor_type, 'RepositoryRole');
  assert.equal(rs.conditions.ref_name.include[0], '~DEFAULT_BRANCH');
});

test('the organization default ruleset adds the cost-bounded MERGE queue', () => {
  const rs = defaultRuleset({ mergeQueueAvailable: true, allowedMergeMethods: ['merge', 'squash'] });
  const pr = rs.rules.find((r) => r.type === 'pull_request');
  const queue = rs.rules.find((r) => r.type === 'merge_queue');
  assert.deepEqual(pr.parameters.allowed_merge_methods, ['merge', 'squash']);
  assert.deepEqual(queue, mergeQueueRule());
  assert.equal(queue.parameters.merge_method, 'MERGE');
  assert.equal(queue.parameters.grouping_strategy, 'ALLGREEN');
  assert.equal(queue.parameters.max_entries_to_build, 1);
  assert.equal(queue.parameters.max_entries_to_merge, 1);
});

test('the organization queue uses an enabled method when merge commits are disabled', () => {
  const rs = defaultRuleset({ mergeQueueAvailable: true, allowedMergeMethods: ['squash', 'rebase'] });
  const queue = rs.rules.find((r) => r.type === 'merge_queue');
  assert.equal(queue.parameters.merge_method, 'SQUASH');
  assert.notEqual(queue.parameters.merge_method, 'MERGE');
});

test('every seed source exists in this checkout', () => {
  for (const seed of Object.values(SEEDS)) {
    assert.ok(existsSync(join(ROOT, seed.source)), `${seed.source} missing`);
    assert.ok(readFileSync(join(ROOT, seed.source), 'utf8').length > 0, `${seed.source} empty`);
  }
});

test('the baseline agent context maps governed repos to shared guidance and skills', () => {
  const baseline = readFileSync(join(ROOT, 'governance/baseline/AGENTS.md'), 'utf8');
  assert.match(baseline, /## Shared agent conventions and skills/);
  assert.match(baseline, /https:\/\/github\.com\/qwts\/playbook-engineering\/blob\/main\/docs\/reference\/agent-conventions\.md/);
  assert.match(baseline, /https:\/\/github\.com\/qwts\/playbook-engineering\/blob\/[0-9a-f]{40}\/skills\/README\.md/);
  assert.match(baseline, /https:\/\/github\.com\/qwts\/playbook-engineering\/blob\/main\/docs\/sop\/README\.md/);
  assert.match(baseline, /https:\/\/github\.com\/qwts\/playbook-engineering\/blob\/main\/docs\/decisions\/README\.md/);
  assert.match(baseline, /Before creating or copying a repo-local skill/);
  assert.match(baseline, /Reuse only the pinned version supplied by the governed harness/);
});

test('every governed harness file is both drift-checked and seeded from the root layer', () => {
  assert.ok(GOVERNED_HARNESS_FILES.length > GOVERNED_CODEX_FILES.length, 'the Claude layer is governed too');
  for (const path of GOVERNED_HARNESS_FILES) {
    assert.ok(BASELINE_FILES.includes(path), `${path} missing from drift baseline`);
    assert.deepEqual(SEEDS[path], { source: path, target: path });
  }
});

test('a missing managed ignore is seeded from the effective manifest projection', () => {
  const excluded = 'tools/agent-guard/run-guarded.mjs';
  const content = baselineSeedContent(
    ROOT,
    { source: '.prettierignore', target: '.prettierignore' },
    { name: 'fixture', codexSync: { exclude: [excluded] } },
  );
  assert.match(content, /^# governed:agent-harness-format:start$/mu);
  assert.match(content, /^tools\/agent-guard\/lib\/leases\.mjs$/mu);
  assert.doesNotMatch(content, new RegExp(`^${excluded.replaceAll('.', '\\.')}$`, 'mu'));
  assert.match(content, /^# governed:agent-harness-format:end$/mu);
});

test('ordinary missing seeds retain their canonical bytes', () => {
  const seed = { source: '.codex/config.toml', target: '.codex/config.toml' };
  assert.equal(
    baselineSeedContent(ROOT, seed, { name: 'fixture', codexSync: { exclude: ['.codex/config.toml'] } }),
    readFileSync(join(ROOT, seed.source), 'utf8'),
  );
});

test('the Codex environment stays project-scoped and the trust rules stay narrow', () => {
  const env = readFileSync(join(ROOT, '.codex/environments/environment.toml'), 'utf8');
  // Setup asserts and uses what the host provides; it never installs tooling,
  // edits shell profiles, or writes outside the worktree. The only PATH export
  // is the win32 launcher scoping /usr/bin:/bin into its Git Bash process.
  assert.doesNotMatch(env, /codex-agent-dev/);
  assert.doesNotMatch(env, /\.zshrc|\.zprofile|\.bash_profile|\.bashrc|\.profile\b/);
  assert.doesNotMatch(env, /opt\/homebrew/);
  assert.doesNotMatch(env, /export PATH=(?!"\/usr\/bin:\/bin:\$PATH")/);
  assert.doesNotMatch(env, /nvm alias default/);
  assert.doesNotMatch(env, /\.codex\/scripts\//);
  // Identity resolution honors AGENT_BOT_BIN, then PATH, then the installed
  // location; installs follow the repository's own lockfile.
  assert.match(env, /AGENT_BOT_BIN/);
  assert.match(env, /setup-worktree/);
  assert.match(env, /\$HOME\/\.local\/bin\/agent-bot/);
  assert.match(env, /npm ci --no-audit --no-fund/);
  assert.match(env, /corepack pnpm install --frozen-lockfile/);
  assert.match(env, /corepack yarn install --immutable/);
  assert.match(env, /bun install --frozen-lockfile/);
  assert.match(env, /npm run --if-present harness:setup/);
  // Both platform sections must run the same POSIX bodies: every win32 script
  // wraps a verbatim copy of its POSIX sibling in a Git Bash launcher.
  const posixBodies = [...env.matchAll(/^\[(setup|cleanup)\]\nscript = '''\n([\s\S]*?)'''/gmu)];
  const win32Bodies = [...env.matchAll(/^\[(setup|cleanup)\.win32\]\nscript = '''\n[\s\S]*?@'\n([\s\S]*?)'@/gmu)];
  assert.equal(posixBodies.length, 2);
  assert.equal(win32Bodies.length, 2);
  for (const [index, [, table, body]] of posixBodies.entries()) {
    assert.equal(win32Bodies[index][1], table, `win32 tables must mirror POSIX order`);
    assert.equal(
      win32Bodies[index][2],
      `export PATH="/usr/bin:/bin:$PATH"\n${body}`,
      `[${table}.win32] must embed the [${table}] body verbatim`,
    );
  }

  const directRule = readFileSync(join(ROOT, '.codex/rules/environment.rules'), 'utf8')
    .split('# Trust standalone, non-destructive GitHub CLI development operations.')[0];
  assert.doesNotMatch(directRule, /^\s*"push",$/mu);
  assert.doesNotMatch(directRule, /^\s*"grep",$/mu);
  for (const subcommand of ['clone', 'fetch', 'pull', 'rebase']) {
    assert.doesNotMatch(directRule, new RegExp(`^\\s*"${subcommand}",$`, 'mu'));
  }
});

test('the governed Codex configuration enables hooks and protects GitHub identity', () => {
  const config = readFileSync(join(ROOT, '.codex/config.toml'), 'utf8');
  assert.match(config, /\[features\][\s\S]*\bhooks = true\b/);
  assert.match(
    config,
    /\[apps\.connector_76869538009648d5b282a4bb21c3d157\]\nenabled = true\ndestructive_enabled = false/,
  );

  for (const skill of [
    'github:yeet',
    'github:github',
    'github:gh-fix-ci',
    'github:gh-address-comments',
  ]) {
    assert.match(
      config,
      new RegExp(`\\[\\[skills\\.config\\]\\]\\nname = "${skill}"\\nenabled = true`),
      `${skill} must remain enabled`,
    );
  }
});

