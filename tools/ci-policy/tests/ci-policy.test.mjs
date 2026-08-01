import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  allowedActorsFromRoster,
  classifyRun,
  isAllowedActor,
  outputsFor,
} from '../../../.github/actions/ci-policy/classify.mjs';

const pullRequest = (draft, fork = false) => ({ pull_request: { draft, head: { repo: { fork } } } });
const roster = JSON.parse(readFileSync(new URL('../../../governance/agents.json', import.meta.url), 'utf8'));
const allowedActors = allowedActorsFromRoster(roster);
const classify = (options) => classifyRun({ allowedActors, ...options });

test('the human, named automation, and active roster Apps are authorized', () => {
  for (const actor of [
    'qwts',
    'chores-dumb[bot]',
    'dependabot[bot]',
    'qwts-codex-agent[bot]',
    'qwts-codex-sol-agent[bot]',
  ]) {
    assert.equal(isAllowedActor(actor, allowedActors), true, actor);
  }
});

test('GitHub, third-party, and unregistered namespace actors are rejected', () => {
  for (const actor of [
    'github-actions[bot]',
    'github-merge-queue[bot]',
    'copilot-swe-agent[bot]',
    'renovate[bot]',
    'qwts-unregistered-agent[bot]',
    'octocat',
  ]) {
    assert.equal(isAllowedActor(actor, allowedActors), false, actor);
  }
});

test('retired roster Apps are rejected', () => {
  const retiredRoster = {
    agents: [...roster.agents, { slug: 'qwts-retired-agent', status: 'retired' }],
  };
  assert.equal(isAllowedActor('qwts-retired-agent[bot]', allowedActorsFromRoster(retiredRoster)), false);
});

test('draft PRs are refused and ready lifecycle events select complete validation', () => {
  assert.throws(
    () => classify({ actor: 'qwts', eventName: 'pull_request', event: pullRequest(true) }),
    /validated locally/,
  );
  assert.equal(classify({ actor: 'qwts', eventName: 'pull_request', event: pullRequest(false) }), 'full');
  assert.equal(
    classify({ actor: 'dependabot[bot]', eventName: 'pull_request', event: pullRequest(false) }),
    'full',
  );
});

test('main pushes and manual reruns select their dedicated modes', () => {
  assert.equal(
    classify({ actor: 'qwts', eventName: 'push', event: {}, ref: 'refs/heads/main' }),
    'post-merge',
  );
  assert.equal(classify({ actor: 'qwts', eventName: 'workflow_dispatch', event: {} }), 'manual');
  assert.equal(outputsFor('manual').run_full, 'true');
});

test('reruns require the triggering actor to be authorized', () => {
  assert.throws(
    () =>
      classify({
        actor: 'qwts',
        triggeringActor: 'octocat',
        eventName: 'workflow_dispatch',
        event: {},
      }),
    /triggering actor octocat is not authorized/,
  );
});

test('fork PRs, unauthorized actors, and unsupported triggers fail closed', () => {
  assert.throws(
    () => classify({ actor: 'qwts', eventName: 'pull_request', event: pullRequest(false, true) }),
    /fork/,
  );
  assert.throws(
    () => classify({ actor: 'github-actions[bot]', eventName: 'push', event: {}, ref: 'refs/heads/main' }),
    /not authorized/,
  );
  assert.throws(() => classify({ actor: 'qwts', eventName: 'merge_group', event: {} }), /not a governed CI trigger/);
  assert.throws(() => classify({ actor: 'qwts', eventName: 'schedule', event: {} }), /not a governed CI trigger/);
});

test('the reference workflow preserves governed gates and skips draft jobs', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /github\.event\.pull_request\.draft == false/);
  assert.match(
    workflow,
    /uses: qwts\/playbook-engineering\/\.github\/actions\/ci-policy@[0-9a-f]{40}/,
  );
  assert.doesNotMatch(workflow, /uses: \.\/\.github\/actions\/ci-policy/);
  assert.doesNotMatch(workflow, /^  merge_group:/m);
  assert.doesNotMatch(workflow, /\.event == "merge_group"/);
  assert.match(workflow, /^  preflight-evidence:$/m);
  assert.match(workflow, /event=workflow_dispatch&head_sha=\$TARGET_SHA/);
  assert.match(workflow, /\.name == "CI" and \.conclusion == "success"/);
  assert.match(workflow, /needs\.preflight-evidence\.outputs\.validated != 'true'/);
  assert.match(workflow, /if \[ "\$PREFLIGHT_VALIDATED" = true \]/);
  assert.match(workflow, /name: Complete suite/);
  assert.match(workflow, /^  docs-gov:$/m);
  assert.match(workflow, /^  dependency-inventory:$/m);
  assert.match(workflow, /name: CI\n/);
  assert.doesNotMatch(workflow, /name: Draft checks/);
});
