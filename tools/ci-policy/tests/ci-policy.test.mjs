import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  allowedActorsFromRoster,
  authorizeRun,
  classifyRun,
  isGeneratedReleaseProjection,
  isAllowedActor,
  isNativeMergeQueueMainPush,
  outputsFor,
  releaseGateOutcome,
  releaseLifecycleFor,
  releaseOutputs,
} from '../../../.github/actions/ci-policy/classify.mjs';
import {
  listMergeGroupPullRequests,
  listPullRequestsForCommit,
  mergeGroupHeadPullRequest,
  resolveReleasePullRequests,
} from '../../../.github/actions/ci-policy/release-origin.mjs';

const pullRequest = (draft, fork = false) => ({ pull_request: { draft, head: { repo: { fork } } } });
const roster = JSON.parse(readFileSync(new URL('../../../governance/agents.json', import.meta.url), 'utf8'));
const releaseCatalog = JSON.parse(
  readFileSync(new URL('../../../governance/release-lifecycles.json', import.meta.url), 'utf8'),
);
const allowedActors = allowedActorsFromRoster(roster);
const classify = (options) => classifyRun({ allowedActors, ...options });

const releasePullRequest = ({
  author = 'qwts',
  baseRef = 'main',
  headRef = 'codex/feature',
  headRepository = 'qwts/overlook',
  fork = false,
} = {}) => ({
  pull_request: {
    draft: false,
    user: { login: author },
    base: { ref: baseRef },
    head: { ref: headRef, repo: { fork, full_name: headRepository } },
  },
});

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

test('reviewed repository lifecycle data classifies only the trusted generated projection', () => {
  const lifecycle = releaseLifecycleFor(releaseCatalog, 'qwts/overlook');
  const trusted = {
    eventName: 'pull_request',
    event: releasePullRequest({ author: 'chores-dumb[bot]', headRef: 'changeset-release/main' }),
    repository: 'qwts/overlook',
    lifecycle,
  };
  assert.equal(isGeneratedReleaseProjection(trusted), true);
  assert.deepEqual(releaseOutputs(trusted), {
    pull_request_kind: 'generated-release-projection',
    generated_release_projection: 'true',
    release_metadata_system: 'changesets',
    source_input_policy: 'behavior-change-changeset-or-reviewed-rationale',
    release_gate_mode: 'generated-projection',
  });

  for (const event of [
    releasePullRequest({ headRef: 'changeset-release/main' }),
    releasePullRequest({ author: 'chores-dumb[bot]', headRef: 'changeset-release/main', headRepository: 'octocat/overlook', fork: true }),
    releasePullRequest({ author: 'chores-dumb[bot]', headRef: 'release/main' }),
  ]) {
    assert.equal(isGeneratedReleaseProjection({ ...trusted, event }), false);
  }
});

test('ordinary automation is not a generated-release exception', () => {
  const lifecycle = releaseLifecycleFor(releaseCatalog, 'qwts/overlook');
  const outputs = releaseOutputs({
    eventName: 'pull_request',
    event: releasePullRequest({ author: 'dependabot[bot]', headRef: 'dependabot/npm_and_yarn/example' }),
    repository: 'qwts/overlook',
    lifecycle,
  });
  assert.equal(outputs.pull_request_kind, 'change-pr');
  assert.equal(outputs.generated_release_projection, 'false');
  assert.equal(outputs.release_gate_mode, 'source-policy');
});

test('manual and post-merge lanes retain the originating generated projection', () => {
  const lifecycle = releaseLifecycleFor(releaseCatalog, 'qwts/overlook');
  const projection = releasePullRequest({
    author: 'chores-dumb[bot]',
    headRef: 'changeset-release/main',
  }).pull_request;
  for (const eventName of ['workflow_dispatch', 'push']) {
    const outputs = releaseOutputs({
      eventName,
      event: {},
      repository: 'qwts/overlook',
      lifecycle,
      pullRequests: [projection],
    });
    assert.equal(outputs.pull_request_kind, 'generated-release-projection');
    assert.equal(outputs.generated_release_projection, 'true');
    assert.equal(outputs.release_gate_mode, 'generated-projection');
  }
});

test('manual and post-merge lanes resolve associated pull requests through the exact commit SHA', async () => {
  const lifecycle = releaseLifecycleFor(releaseCatalog, 'qwts/overlook');
  const projection = releasePullRequest({
    author: 'chores-dumb[bot]',
    headRef: 'changeset-release/main',
  }).pull_request;
  const requests = [];
  const options = {
    eventName: 'workflow_dispatch',
    event: {},
    repository: 'qwts/overlook',
    lifecycle,
    sha: 'a'.repeat(40),
    apiUrl: 'https://api.github.example',
    token: 'test-token',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return { ok: true, json: async () => [projection] };
    },
  };
  assert.deepEqual(await resolveReleasePullRequests(options), [projection]);
  assert.equal(
    requests[0].url,
    `https://api.github.example/repos/qwts/overlook/commits/${'a'.repeat(40)}/pulls?per_page=100`,
  );
  assert.equal(requests[0].init.headers.Authorization, 'Bearer test-token');
});

test('merge groups resolve every constituent pull request from queue evidence', async () => {
  const lifecycle = releaseLifecycleFor(releaseCatalog, 'qwts/overlook');
  const event = {
    merge_group: { head_ref: 'refs/heads/gh-readonly-queue/main/pr-116-e8c01cbc4c17' },
  };
  assert.deepEqual(mergeGroupHeadPullRequest(event), { baseRef: 'main', number: 116 });
  const requests = [];
  const options = {
    eventName: 'merge_group',
    event,
    repository: 'qwts/overlook',
    lifecycle,
    graphqlUrl: 'https://api.github.example/graphql',
    token: 'test-token',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      const after = requests.at(-1).body.variables.after;
      return {
        ok: true,
        json: async () => ({
          data: {
            repository: {
              pullRequest: {
                mergeQueueEntry: {
                  position: 2,
                  mergeQueue: {
                    entries: {
                      nodes: after
                        ? [
                            {
                              position: 2,
                              pullRequest: {
                                number: 116,
                                baseRefName: 'main',
                                headRefName: 'changeset-release/main',
                                headRepository: { nameWithOwner: 'qwts/overlook' },
                                author: { __typename: 'Bot', login: 'chores-dumb' },
                              },
                            },
                            { position: 3, pullRequest: { number: 117 } },
                          ]
                        : [
                            {
                              position: 1,
                              pullRequest: {
                                number: 115,
                                baseRefName: 'main',
                                headRefName: 'codex/source-change',
                                headRepository: { nameWithOwner: 'qwts/overlook' },
                                author: { __typename: 'User', login: 'qwts' },
                              },
                            },
                          ],
                      pageInfo: after
                        ? { hasNextPage: false, endCursor: null }
                        : { hasNextPage: true, endCursor: 'queue-cursor' },
                    },
                  },
                },
              },
            },
          },
        }),
      };
    },
  };
  const pullRequests = await listMergeGroupPullRequests(options);
  assert.equal(pullRequests.length, 2);
  assert.equal(pullRequests[1].number, 116);
  assert.equal(pullRequests[1].user.login, 'chores-dumb[bot]');
  assert.equal(requests[0].url, options.graphqlUrl);
  assert.equal(requests[0].body.variables.number, 116);
  assert.equal(requests[1].body.variables.after, 'queue-cursor');
  assert.equal(releaseOutputs({ ...options, pullRequests }).release_gate_mode, 'generated-projection');
});

test('mixed merge groups classify only the current head pull request', () => {
  const lifecycle = releaseLifecycleFor(releaseCatalog, 'qwts/overlook');
  const event = {
    merge_group: { head_ref: 'refs/heads/gh-readonly-queue/main/pr-116-e8c01cbc4c17' },
  };
  const generated = {
    number: 115,
    ...releasePullRequest({
      author: 'chores-dumb[bot]',
      headRef: 'changeset-release/main',
    }).pull_request,
  };
  const source = {
    number: 116,
    ...releasePullRequest({ headRef: 'codex/source-change' }).pull_request,
  };
  const outputs = releaseOutputs({
    eventName: 'merge_group',
    event,
    repository: 'qwts/overlook',
    lifecycle,
    pullRequests: [generated, source],
  });
  assert.equal(outputs.pull_request_kind, 'change-pr');
  assert.equal(outputs.generated_release_projection, 'false');
  assert.equal(outputs.release_gate_mode, 'source-policy');
  assert.throws(
    () => releaseOutputs({
      eventName: 'merge_group',
      event,
      repository: 'qwts/overlook',
      lifecycle,
      pullRequests: [generated],
    }),
    /does not uniquely identify head pull request #116/,
  );
});

test('release-origin lookup fails closed on missing or malformed evidence', async () => {
  const base = {
    repository: 'qwts/overlook',
    sha: 'b'.repeat(40),
    apiUrl: 'https://api.github.example',
    token: 'test-token',
  };
  await assert.rejects(
    () => listPullRequestsForCommit({ ...base, fetchImpl: async () => ({ ok: false, status: 403 }) }),
    /HTTP 403/,
  );
  await assert.rejects(
    () => listPullRequestsForCommit({ ...base, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }),
    /malformed data/,
  );
  await assert.rejects(
    () => resolveReleasePullRequests({
      ...base,
      eventName: 'push',
      event: {},
      lifecycle: releaseLifecycleFor(releaseCatalog, 'qwts/overlook'),
      fetchImpl: async () => ({ ok: true, json: async () => [] }),
    }),
    /no pull request origin is available/,
  );
  await assert.rejects(
    () => listMergeGroupPullRequests({
      ...base,
      event: { merge_group: { head_ref: 'refs/heads/not-a-queue' } },
      graphqlUrl: 'https://api.github.example/graphql',
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    }),
    /head ref .* is malformed/,
  );
  await assert.rejects(
    () => listMergeGroupPullRequests({
      ...base,
      event: { merge_group: { head_ref: 'refs/heads/gh-readonly-queue/main/pr-116-abc123' } },
      graphqlUrl: 'https://api.github.example/graphql',
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ errors: [{ message: 'queue entry unavailable' }] }),
      }),
    }),
    /GraphQL lookup returned errors/,
  );
});

test('source inputs and generated projections follow distinct release gates', () => {
  const source = {
    metadataSystem: 'changesets',
    generatedReleaseProjection: false,
    sourceRequirementApplies: true,
    semanticReleaseCount: null,
  };
  assert.equal(releaseGateOutcome({ ...source, sourceInputsValid: true }), 'pass-source-inputs');
  assert.equal(releaseGateOutcome({ ...source, sourceInputsValid: false }), 'fail-source-inputs');
  assert.equal(
    releaseGateOutcome({ ...source, sourceRequirementApplies: false, sourceInputsValid: false }),
    'pass-source-inputs-not-required',
  );
  assert.equal(
    releaseGateOutcome({ ...source, generatedReleaseProjection: true, semanticReleaseCount: 0 }),
    'pass-generated-projection',
  );
  assert.equal(
    releaseGateOutcome({ ...source, generatedReleaseProjection: true, semanticReleaseCount: 1 }),
    'fail-generated-pending-releases',
  );
  assert.equal(releaseGateOutcome({ ...source, metadataSystem: 'none' }), 'not-applicable');
});

test('unauthorized bots and forks cannot claim the generated projection path', () => {
  const event = releasePullRequest({ author: 'chores-dumb[bot]', headRef: 'changeset-release/main' });
  assert.throws(
    () => classify({ actor: 'renovate[bot]', triggeringActor: 'renovate[bot]', eventName: 'pull_request', event }),
    /not authorized/,
  );
  assert.throws(
    () => classify({ actor: 'qwts', eventName: 'pull_request', event: releasePullRequest({ author: 'chores-dumb[bot]', headRef: 'changeset-release/main', headRepository: 'octocat/overlook', fork: true }) }),
    /fork/,
  );
});

test('the reference workflow preserves governed gates and skips draft jobs', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const policyAction = readFileSync(
    new URL('../../../.github/actions/ci-policy/action.yml', import.meta.url),
    'utf8',
  );
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
  assert.match(workflow, /generated_release_projection: \$\{\{ steps\.policy\.outputs\.generated_release_projection \}\}/);
  assert.match(workflow, /release_gate_mode: \$\{\{ steps\.policy\.outputs\.release_gate_mode \}\}/);
  assert.match(workflow, /^  pull-requests: read$/m);
  assert.match(policyAction, /CI_POLICY_GRAPHQL_URL: \$\{\{ github\.graphql_url \}\}/);
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
