import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  discoveryDisposition,
  extractDiscoveryBlock,
  hasCanonicalDiscoveryBlock,
  projectDiscoveryBlock,
} from '../lib/agent-context-discovery.mjs';
import { plan, promotionPlan } from '../lib/reconcile-plan.mjs';
import { activeDrift } from '../drift.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const canonical = extractDiscoveryBlock(readFileSync(join(ROOT, 'governance/baseline/AGENTS.md'), 'utf8'));

test('the marked baseline is the one canonical discovery block', () => {
  assert.ok(canonical);
  assert.match(canonical, /^<!-- governed:shared-agent-discovery:start -->\n\n## /);
  assert.match(canonical, /blob\/main\/docs\/reference\/agent-conventions\.md/);
  assert.match(canonical, /blob\/[0-9a-f]{40}\/skills\/README\.md/);
  assert.match(canonical, /blob\/main\/docs\/sop\/README\.md/);
  assert.match(canonical, /blob\/main\/docs\/decisions\/README\.md/);
});

test('the governance source repository consumes its own canonical block', () => {
  const context = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  assert.equal(hasCanonicalDiscoveryBlock(context, canonical), true);
});

test('active discovery drift fails closed while onboarding records migration', () => {
  const active = discoveryDisposition('active', '# Context\n', canonical);
  const onboarding = discoveryDisposition('onboarding', '# Context\n', canonical);
  assert.deepEqual(active, { conformant: false, state: 'drift', blocksPromotion: true });
  assert.deepEqual(onboarding, { conformant: false, state: 'migration', blocksPromotion: true });
});

test('only active discovery failures are blocking drift', () => {
  const results = [
    { name: 'active-pass', status: 'active', failed: [] },
    { name: 'active-fail', status: 'active', failed: ['shared agent-context discovery'] },
    { name: 'onboarding-migration', status: 'onboarding', failed: ['shared agent-context discovery'] },
  ];
  assert.deepEqual(activeDrift(results).map((result) => result.name), ['active-fail']);
});

test('a stale canonical link is not conformant', () => {
  const stale = canonical.replaceAll('/blob/main/', '/blob/master/');
  assert.equal(hasCanonicalDiscoveryBlock(stale, canonical), false);
  assert.equal(discoveryDisposition('active', stale, canonical).state, 'drift');
});

test('projection retires stale playbook master links without changing local links', () => {
  const source = '# Context\n\nSee https://github.com/qwts/playbook-engineering/blob/master/docs/decisions/ENG-0006-agentic-primitives-governance.md and https://github.com/qwts/legacy/blob/master/README.md.\n';
  const projected = projectDiscoveryBlock(source, canonical);
  assert.doesNotMatch(projected, /playbook-engineering\/blob\/master\//);
  assert.match(projected, /playbook-engineering\/blob\/main\//);
  assert.match(projected, /qwts\/legacy\/blob\/master\//);
});

test('duplicate marked discovery blocks fail conformance and reconcile to one block', () => {
  const duplicated = `# Context\n\n${canonical}\n\n## Local rules\n\nKeep this.\n\n${canonical}\n`;
  assert.equal(hasCanonicalDiscoveryBlock(duplicated, canonical), false);
  const projected = projectDiscoveryBlock(duplicated, canonical);
  assert.equal(hasCanonicalDiscoveryBlock(projected, canonical), true);
  assert.equal(projected.split('governed:shared-agent-discovery:start').length - 1, 1);
  assert.match(projected, /## Local rules\n\nKeep this\./);
});

test('projection replaces a legacy shared section and is idempotent', () => {
  const legacy = `# Context\n\n## Shared agent conventions\n\nOld shared guidance.\n\n## Local rules\n\nKeep this.\n`;
  const once = projectDiscoveryBlock(legacy, canonical);
  const twice = projectDiscoveryBlock(once, canonical);
  assert.equal(twice, once);
  assert.ok(hasCanonicalDiscoveryBlock(once, canonical));
  assert.match(once, /## Local rules\n\nKeep this\./);
  assert.doesNotMatch(once, /Old shared guidance/);
});

test('a discovery gap plans a targeted projection, not a replacement seed', () => {
  const result = plan({ name: 'existing', status: 'active', failed: ['shared agent-context discovery'] });
  assert.deepEqual(result.seeds, []);
  assert.deepEqual(result.projections, [{
    check: 'shared agent-context discovery',
    target: 'AGENTS.md',
    action: 'project-shared-agent-discovery',
  }]);
});

test('an onboarding repository cannot be promoted until discovery is conformant', () => {
  assert.deepEqual(
    promotionPlan({ name: 'localnotes', status: 'onboarding', failed: ['shared agent-context discovery'] }),
    { eligible: false, reasons: ['shared agent-context discovery'] },
  );
  assert.deepEqual(
    promotionPlan({ name: 'ready', status: 'onboarding', failed: [] }),
    { eligible: true, reasons: [] },
  );
});
