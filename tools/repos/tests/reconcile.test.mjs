import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { plan, bumpReviewCount, defaultRuleset, SEEDS } from '../lib/reconcile-plan.mjs';

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
    ['AGENTS.md', '.github/ISSUE_TEMPLATE/feature.yml'],
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
