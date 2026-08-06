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
import { parseReconcileArgs, reconciliationPullAction } from '../reconcile.mjs';
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

test('the protected Git wrapper keeps destructive pushes behind normal approval', {
  skip: !existsSync('/bin/zsh'),
}, (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'codex-git-wrapper-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const fakeGit = join(temp, 'git');
  writeFileSync(fakeGit, '#!/bin/sh\nprintf "%s\\n" "$*"\n');
  chmodSync(fakeGit, 0o755);

  const run = (...args) =>
    spawnSync('/bin/zsh', [join(ROOT, '.codex/scripts/git-with-nvm.zsh'), ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${temp}:${process.env.PATH}`, NVM_DIR: join(temp, 'missing-nvm') },
    });

  for (const args of [
    ['push', '--set-upstream', 'origin', 'branch'],
    ['push', '--dry-run', 'origin', 'branch'],
    ['push', '--atomic', '--follow-tags', 'origin', 'branch'],
    ['push', '--push-option=ci.skip', 'origin', 'branch'],
    ['push', '--no-force', 'origin', 'branch'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^push /);
  }

  for (const args of [
    ['push', '--force', 'origin', 'branch'],
    ['push', '--force-with-lease', 'origin', 'branch'],
    ['push', '--force-w', 'origin', 'branch'],
    ['push', '--delete', 'origin', 'branch'],
    ['push', '--dele', 'origin', 'branch'],
    ['push', '--mirror', 'origin'],
    ['push', '--mir', 'origin'],
    ['push', '--pru', 'origin'],
    ['push', '--exec=/tmp/receive-pack', '/tmp/remote', 'branch'],
    ['push', '--receive-pack', '/tmp/receive-pack', '/tmp/remote', 'branch'],
    ['rebase', '--exec', '/tmp/command', 'main'],
    ['rebase', '-x/tmp/command', 'main'],
    ['clone', '--upload-pack=/tmp/program', '/tmp/remote'],
    ['fetch', '--upload-pack', '/tmp/program', 'origin'],
    ['push', '--future-option', 'origin', 'branch'],
    ['push', 'origin', '+branch:branch'],
    ['push', 'origin', ':branch'],
    ['push', 'origin', 'branch:'],
    ['push', '-uf', 'origin', 'branch'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 64, `${args.join(' ')} unexpectedly passed`);
    assert.match(result.stderr, /requires normal Codex approval/);
  }

  const directRule = readFileSync(join(ROOT, '.codex/rules/environment.rules'), 'utf8')
    .split('# Trust standalone, non-destructive GitHub CLI development operations.')[0];
  assert.doesNotMatch(directRule, /^\s*"push",$/mu);
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

test('the protected GitHub wrapper preserves the installed agent-bot identity shim', {
  skip: !existsSync('/bin/zsh'),
}, (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'codex-gh-wrapper-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const home = join(temp, 'home');
  const shimDir = join(home, '.config', 'agent-bot', 'bin');
  const zdot = join(temp, 'zdot');
  mkdirSync(shimDir, { recursive: true });
  mkdirSync(zdot);
  const fakeShim = join(shimDir, 'gh');
  writeFileSync(fakeShim, '#!/bin/sh\nprintf "agent-bot:%s\\n" "$*"\n');
  chmodSync(fakeShim, 0o755);
  writeFileSync(join(zdot, '.zshenv'), 'export PATH="/opt/homebrew/bin:$PATH"\n');

  const result = spawnSync('/bin/zsh', [join(ROOT, '.codex/scripts/gh.zsh'), '--version'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PATH: '/usr/bin:/bin', ZDOTDIR: zdot },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'agent-bot:--version');

  const source = readFileSync(join(ROOT, '.codex/scripts/gh.zsh'), 'utf8');
  assert.doesNotMatch(source, /export PATH="\/opt\/homebrew\/bin:\$PATH"/);
  const shimIndex = source.indexOf('.config/agent-bot/bin/gh');
  const pathIndex = source.indexOf('command -v gh');
  const fallbackIndex = source.indexOf('/opt/homebrew/bin/gh');
  assert.notEqual(shimIndex, -1, 'the agent-bot shim path must be present');
  assert.notEqual(pathIndex, -1, 'the inherited PATH lookup must be present');
  assert.notEqual(fallbackIndex, -1, 'the Homebrew fallback must be present');
  assert.ok(
    shimIndex < pathIndex && pathIndex < fallbackIndex,
    'the agent-bot shim and inherited PATH must be preferred before the Homebrew fallback',
  );
});

test('setup respects npm, pnpm, yarn, and bun lockfile selection', (t) => {
  const fixtures = [
    { manager: 'npm', packageManager: null, lockfile: 'package-lock.json', expected: 'ci --no-audit --no-fund' },
    { manager: 'pnpm', packageManager: null, lockfile: 'pnpm-lock.yaml', expected: 'install --frozen-lockfile' },
    { manager: 'yarn', packageManager: 'yarn@4.9.0', lockfile: 'yarn.lock', expected: 'install --immutable' },
    { manager: 'bun', packageManager: 'bun@1.2.0', lockfile: 'bun.lock', expected: 'install --frozen-lockfile' },
  ];

  for (const fixture of fixtures) {
    const temp = mkdtempSync(join(tmpdir(), `codex-setup-${fixture.manager}-`));
    t.after(() => rmSync(temp, { recursive: true, force: true }));
    const bin = join(temp, 'bin');
    const home = join(temp, 'home');
    const log = join(temp, 'manager.log');
    mkdirSync(bin);
    mkdirSync(home);
    writeFileSync(
      join(temp, 'package.json'),
      `${JSON.stringify({
        name: `fixture-${fixture.manager}`,
        private: true,
        scripts: {},
        ...(fixture.packageManager ? { packageManager: fixture.packageManager } : {}),
      })}\n`,
    );
    writeFileSync(join(temp, fixture.lockfile), '');
    if (fixture.manager === 'yarn') writeFileSync(join(temp, '.yarnrc.yml'), 'nodeLinker: node-modules\n');

    const fakeManager = join(bin, fixture.manager);
    writeFileSync(
      fakeManager,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0.0; exit 0; fi\nprintf "%s\\n" "$*" >> "$PM_LOG"\n',
    );
    chmodSync(fakeManager, 0o755);
    const fakeGh = join(bin, 'gh');
    writeFileSync(fakeGh, '#!/bin/sh\necho "gh version test"\n');
    chmodSync(fakeGh, 0o755);

    const result = spawnSync('bash', [join(ROOT, '.codex/scripts/setup.sh')], {
      cwd: temp,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, PM_LOG: log },
    });
    assert.equal(result.status, 0, `${fixture.manager}: ${result.stderr}\n${result.stdout}`);
    assert.equal(readFileSync(log, 'utf8').trim(), fixture.expected);
  }
});

test('setup selects Node per worktree without changing the global nvm default', () => {
  const source = readFileSync(join(ROOT, '.codex/scripts/setup.sh'), 'utf8');
  assert.doesNotMatch(source, /nvm alias default/);
  assert.match(source, /codex_repo_root=.*git rev-parse --show-toplevel/);
  assert.match(source, /nvm use .*codex_repo_root.*\.nvmrc/);
  assert.match(source, /bash \.codex\/scripts\/ensure-identity\.sh/);
  assert.doesNotMatch(source, /ensure-identity\.sh.*\|\| true/);
});
