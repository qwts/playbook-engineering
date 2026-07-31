import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { classifyRun, isAllowedActor, outputsFor } from '../../../.github/actions/ci-policy/classify.mjs';

const pullRequest = (draft, fork = false) => ({ pull_request: { draft, head: { repo: { fork } } } });

test('the human, release bot, and qwts agent Apps are authorized', () => {
  for (const actor of ['qwts', 'chores-dumb[bot]', 'qwts-codex-agent[bot]', 'qwts-codex-sol-agent[bot]']) {
    assert.equal(isAllowedActor(actor), true, actor);
  }
});

test('GitHub and third-party actors are rejected', () => {
  for (const actor of ['github-actions[bot]', 'dependabot[bot]', 'renovate[bot]', 'octocat']) {
    assert.equal(isAllowedActor(actor), false, actor);
  }
});

test('draft PRs are refused and ready lifecycle events select complete validation', () => {
  assert.throws(
    () => classifyRun({ actor: 'qwts', eventName: 'pull_request', event: pullRequest(true) }),
    /validated locally/,
  );
  assert.equal(classifyRun({ actor: 'qwts', eventName: 'pull_request', event: pullRequest(false) }), 'full');
  assert.equal(classifyRun({ actor: 'qwts', eventName: 'merge_group', event: {} }), 'full');
});

test('main pushes and manual reruns select their dedicated modes', () => {
  assert.equal(
    classifyRun({ actor: 'qwts', eventName: 'push', event: {}, ref: 'refs/heads/main' }),
    'post-merge',
  );
  assert.equal(classifyRun({ actor: 'qwts', eventName: 'workflow_dispatch', event: {} }), 'manual');
  assert.equal(outputsFor('manual').run_full, 'true');
});

test('fork PRs, unauthorized actors, and unsupported triggers fail closed', () => {
  assert.throws(
    () => classifyRun({ actor: 'qwts', eventName: 'pull_request', event: pullRequest(false, true) }),
    /fork/,
  );
  assert.throws(
    () => classifyRun({ actor: 'github-actions[bot]', eventName: 'push', event: {}, ref: 'refs/heads/main' }),
    /not authorized/,
  );
  assert.throws(() => classifyRun({ actor: 'qwts', eventName: 'schedule', event: {} }), /not a governed CI trigger/);
});

test('the reference workflow preserves governed gates and skips draft jobs', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /github\.event\.pull_request\.draft == false/);
  assert.match(workflow, /name: Complete suite/);
  assert.match(workflow, /^  docs-gov:$/m);
  assert.match(workflow, /^  dependency-inventory:$/m);
  assert.match(workflow, /name: CI\n/);
  assert.doesNotMatch(workflow, /name: Draft checks/);
});
