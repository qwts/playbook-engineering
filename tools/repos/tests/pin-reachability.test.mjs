import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { extractFirstPartyPins, isReachableCompareStatus, uniquePinTargets } from '../pin-reachability.mjs';

describe('first-party pin extraction', () => {
  test('finds SHA-pinned first-party actions and ignores tags and third parties', () => {
    const workflow = [
      'jobs:',
      '  a:',
      '    steps:',
      '      - uses: qwts/playbook-engineering/.github/actions/ci-policy@4e70c773155c2c804e52a487352627010bea1897',
      '      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
      '      - uses: qwts/other-repo/action@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # comment',
      "      - uses: 'qwts/quoted/act@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'",
      '      - uses: qwts/tagged/action@v1',
    ].join('\n');
    const pins = extractFirstPartyPins(workflow, { owner: 'qwts' });
    assert.deepEqual(
      pins.map((p) => `${p.repo}/${p.path}@${p.sha.slice(0, 8)}`),
      ['playbook-engineering/.github/actions/ci-policy@4e70c773', 'other-repo/action@aaaaaaaa', 'quoted/act@bbbbbbbb'],
    );
    // actions/checkout is third-party (owner 'actions'), the @v1 tag is not a SHA pin.
    assert.ok(!pins.some((p) => p.repo === 'checkout'));
    assert.ok(!pins.some((p) => p.repo === 'tagged'));
  });

  test('records the line number for actionable reporting', () => {
    const pins = extractFirstPartyPins('\n\n- uses: qwts/r/p@' + 'c'.repeat(40), { owner: 'qwts' });
    assert.equal(pins[0].line, 3);
  });

  test('a non-40-hex ref is not treated as a reachability-checkable pin', () => {
    assert.equal(extractFirstPartyPins('- uses: qwts/r/p@abc123', { owner: 'qwts' }).length, 0);
    assert.equal(extractFirstPartyPins('- uses: qwts/r/p@' + 'g'.repeat(40), { owner: 'qwts' }).length, 0);
  });
});

describe('compare-status reachability', () => {
  test('identical and behind mean the pinned commit is reachable from the base', () => {
    assert.equal(isReachableCompareStatus('identical'), true);
    assert.equal(isReachableCompareStatus('behind'), true);
  });

  test('ahead and diverged mean it is not — the dangling-pin case', () => {
    assert.equal(isReachableCompareStatus('ahead'), false);
    assert.equal(isReachableCompareStatus('diverged'), false);
    assert.equal(isReachableCompareStatus(undefined), false);
  });
});

describe('target dedupe', () => {
  test('the same repo+sha pinned by several workflows is verified once', () => {
    const targets = uniquePinTargets([
      { owner: 'qwts', repo: 'pe', path: 'a', sha: 'x'.repeat(40) },
      { owner: 'qwts', repo: 'pe', path: 'b', sha: 'x'.repeat(40) },
      { owner: 'qwts', repo: 'pe', path: 'a', sha: 'y'.repeat(40) },
    ]);
    assert.equal(targets.length, 2);
  });
});
