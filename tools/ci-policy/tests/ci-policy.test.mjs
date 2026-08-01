import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  allowedActorsFromRoster,
  authorizeRun,
  classifyRun,
  isAllowedActor,
  isNativeMergeQueueMainPush,
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

test('only the native merge-queue bot pair may initiate a main push', () => {
  const nativePush = {
    actor: 'github-merge-queue[bot]',
    triggeringActor: 'github-merge-queue[bot]',
    eventName: 'push',
    event: {},
    ref: 'refs/heads/main',
  };
  assert.equal(isNativeMergeQueueMainPush(nativePush), true);
  assert.equal(classify(nativePush), 'post-merge');

  for (const override of [
    { triggeringActor: 'qwts' },
    { eventName: 'merge_group' },
    { ref: 'refs/heads/release' },
  ]) {
    const attempt = { ...nativePush, ...override };
    assert.equal(isNativeMergeQueueMainPush(attempt), false);
    assert.throws(() => classify(attempt), /not authorized/);
  }
});

test('authorization-only enforcement protects non-CI entrypoints', () => {
  for (const eventName of ['workflow_dispatch', 'schedule']) {
    assert.doesNotThrow(() =>
      authorizeRun({
        actor: 'qwts',
        triggeringActor: 'qwts',
        allowedActors,
        eventName,
        event: {},
        ref: 'refs/heads/main',
      }),
    );
  }
  assert.throws(
    () =>
      authorizeRun({
        actor: 'octocat',
        triggeringActor: 'octocat',
        allowedActors,
        eventName: 'workflow_dispatch',
        event: {},
        ref: 'refs/heads/main',
      }),
    /actor octocat is not authorized/,
  );
  assert.throws(
    () =>
      authorizeRun({
        actor: 'qwts',
        triggeringActor: 'qwts',
        allowedActors,
        eventName: 'pull_request_target',
        event: pullRequest(false, true),
        ref: 'refs/heads/main',
      }),
    /fork/,
  );
});

test('merge queue candidates for main select a fresh complete-suite run', () => {
  const event = {
    action: 'checks_requested',
    merge_group: {
      base_ref: 'refs/heads/main',
      head_ref: 'refs/heads/gh-readonly-queue/main/pr-116-e8c01cbc4c17',
    },
  };
  assert.equal(classify({ actor: 'qwts', eventName: 'merge_group', event }), 'queue');
  assert.equal(classify({ actor: 'qwts-codex-agent[bot]', eventName: 'merge_group', event }), 'queue');
  assert.equal(outputsFor('queue').run_full, 'true');
  assert.throws(
    () => classify({ actor: 'github-merge-queue[bot]', eventName: 'merge_group', event }),
    /not authorized/,
  );
  assert.throws(
    () => classify({ actor: 'qwts', eventName: 'merge_group', event: { ...event, action: 'destroyed' } }),
    /not supported/,
  );
  assert.throws(
    () => classify({
      actor: 'qwts',
      eventName: 'merge_group',
      event: { ...event, merge_group: { ...event.merge_group, base_ref: 'refs/heads/release' } },
    }),
    /not governed/,
  );
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
  assert.match(workflow, /^  merge_group:\n    types: \[checks_requested\]$/m);
  assert.match(workflow, /format\('merge-group-\{0\}', github\.event\.merge_group\.head_ref\)/);
  assert.match(workflow, /\.event == "pull_request" or \.event == "merge_group"/);
  assert.match(workflow, /^  preflight-evidence:$/m);
  assert.match(workflow, /event=workflow_dispatch&head_sha=\$TARGET_SHA/);
  assert.match(workflow, /\.name == "CI" and \.conclusion == "success"/);
  assert.match(workflow, /needs\.preflight-evidence\.outputs\.validated != 'true'/);
  assert.match(workflow, /if \[ "\$PREFLIGHT_VALIDATED" = true \]/);
  assert.match(workflow, /name: Complete suite/);
  assert.match(workflow, /^  docs-gov:$/m);
  assert.match(workflow, /^  dependency-inventory:$/m);
  assert.match(workflow, /^  codeql:$/m);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/codeql\.yml/);
  assert.match(workflow, /needs\.policy\.outputs\.run_post_merge == 'true'/);
  assert.match(workflow, /CODEQL: \$\{\{ needs\.codeql\.result \}\}/);
  assert.match(workflow, /test "\$CODEQL" = success/);
  assert.match(workflow, /queue\|manual\)/);
  assert.match(workflow, /name: CI\n/);
  assert.doesNotMatch(workflow, /name: Draft checks/);
});

test('every direct non-CI workflow entrypoint enforces authorization first', () => {
  for (const path of ['codex-sync.yml', 'inventory-catalog.yml']) {
    const workflow = readFileSync(new URL(`../../../.github/workflows/${path}`, import.meta.url), 'utf8');
    assert.match(workflow, /^  policy:$/m);
    assert.match(workflow, /authorization-only: 'true'/);
    assert.match(workflow, /uses: qwts\/playbook-engineering\/\.github\/actions\/ci-policy@[0-9a-f]{40}/);
    assert.match(workflow, /needs: policy/);
  }
});

test('advanced CodeQL is callable only through governed CI with stable coverage', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/codeql.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^  workflow_call:$/m);
  assert.doesNotMatch(workflow, /^  (?:pull_request|push|workflow_dispatch|schedule):$/m);
  assert.match(workflow, /security-events: write/);
  assert.match(workflow, /language: \[actions, javascript-typescript\]/);
  assert.match(workflow, /name: Analyze \(\$\{\{ matrix\.language \}\}\)/);
  assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1/);
  assert.match(workflow, /github\/codeql-action\/init@f205ea1c3313d32999d8d6a48b4f6530d4437b38 # v4\.37\.4/);
  assert.match(workflow, /github\/codeql-action\/analyze@f205ea1c3313d32999d8d6a48b4f6530d4437b38 # v4\.37\.4/);
});
