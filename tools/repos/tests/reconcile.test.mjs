import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { plan, bumpReviewCount, defaultRuleset, SEEDS } from '../lib/reconcile-plan.mjs';
import { BASELINE_FILES, GOVERNED_CODEX_FILES } from '../lib/baseline-files.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('a fully conformant repo plans nothing', () => {
  const p = plan({ name: 'clean', status: 'active', failed: [] });
  assert.deepEqual([p.settings, p.seeds, p.human], [[], [], []]);
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

test('the default ruleset requires one review and keeps the solo-admin bypass', () => {
  const rs = defaultRuleset();
  const pr = rs.rules.find((r) => r.type === 'pull_request');
  assert.equal(pr.parameters.required_approving_review_count, 1);
  assert.equal(rs.bypass_actors[0].actor_type, 'RepositoryRole');
  assert.equal(rs.conditions.ref_name.include[0], '~DEFAULT_BRANCH');
});

test('every seed source exists in this checkout', () => {
  for (const seed of Object.values(SEEDS)) {
    assert.ok(existsSync(join(ROOT, seed.source)), `${seed.source} missing`);
    assert.ok(readFileSync(join(ROOT, seed.source), 'utf8').length > 0, `${seed.source} empty`);
  }
});

test('every governed Codex file is both drift-checked and seeded from the root layer', () => {
  assert.ok(GOVERNED_CODEX_FILES.length > 0);
  for (const path of GOVERNED_CODEX_FILES) {
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

test('the governed Codex configuration explicitly enables project hooks', () => {
  const config = readFileSync(join(ROOT, '.codex/config.toml'), 'utf8');
  assert.match(config, /\[features\][\s\S]*\bhooks = true\b/);
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
});
