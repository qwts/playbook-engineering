import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  allowedActorsFromRoster,
  authorizeRun,
  classifyRun,
  harnessProjectionChangedFiles,
  isGeneratedReleaseProjection,
  isGovernedHarnessProjection,
  isAllowedActor,
  isNativeMergeQueueMainPush,
  outputsFor,
  releaseLifecycleFor,
  releaseOutputs,
} from '../../../.github/actions/ci-policy/classify.mjs';
import {
  getPullRequest,
  listPullRequestFiles,
  listPullRequestsForCommit,
  mergeGroupHeadPullRequest,
  resolveReleaseOrigins,
} from '../../../.github/actions/ci-policy/release-origin.mjs';
import {
  CODEX_SOURCE_REPO,
  CODEX_SYNC_BOT,
  CODEX_SYNC_BRANCH,
  syncPullBody,
} from '../../repos/lib/codex-sync.mjs';

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
  number = 27,
  body = '',
} = {}) => ({
  pull_request: {
    number,
    body,
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

const overlook = releaseLifecycleFor(releaseCatalog, 'qwts/overlook');
const projection = releasePullRequest({
  author: 'chores-dumb[bot]',
  headRef: 'changeset-release/main',
}).pull_request;
const source = releasePullRequest({ headRef: 'codex/source-change' }).pull_request;
const releaseRun = (overrides) => ({
  eventName: 'pull_request',
  repository: 'qwts/overlook',
  lifecycle: overlook,
  event: {},
  pullRequests: [],
  ...overrides,
});

test('only the reviewed projection identity classifies as generated release output', () => {
  assert.deepEqual(releaseOutputs(releaseRun({ pullRequests: [projection] })), {
    pull_request_kind: 'generated-release-projection',
    generated_release_projection: 'true',
    governed_harness_projection: 'false',
    release_metadata_system: 'changesets',
    source_input_policy: 'behavior-change-changeset-or-reviewed-rationale',
    release_gate_mode: 'generated-projection',
  });

  // Each near miss varies exactly one field of the reviewed identity.
  for (const [reason, pullRequest] of [
    ['author', releasePullRequest({ headRef: 'changeset-release/main' })],
    ['head ref', releasePullRequest({ author: 'chores-dumb[bot]', headRef: 'release/main' })],
    ['base ref', releasePullRequest({ author: 'chores-dumb[bot]', headRef: 'changeset-release/main', baseRef: 'next' })],
    ['head repository', releasePullRequest({ author: 'chores-dumb[bot]', headRef: 'changeset-release/main', headRepository: 'octocat/overlook', fork: true })],
  ]) {
    assert.equal(
      isGeneratedReleaseProjection(releaseRun({ pullRequests: [pullRequest.pull_request] })),
      false,
      `a forged ${reason} must not classify as generated`,
    );
  }
});

const harnessSource = 'e7c2c4992f8472dfced79afc258f4ad18bf226ad';
const managedHarnessFiles = [
  { filename: '.codex/config.toml' },
  { filename: 'tools/agent-guard/run-guarded.mjs' },
];

const harnessPullRequest = (overrides = {}) => releasePullRequest({
  author: 'chores-dumb[bot]',
  headRef: 'governance/harness-sync',
  body: syncPullBody({
    owner: 'qwts',
    sourceSha: harnessSource,
    paths: managedHarnessFiles.map((file) => file.filename),
  }),
  ...overrides,
}).pull_request;

test('pure governed harness projections bypass release input across the Changesets fleet', () => {
  for (const repository of ['qwts/overlook', 'qwts/image-trail', 'qwts/cartograph', 'qwts/bookmarkit']) {
    const lifecycle = releaseLifecycleFor(releaseCatalog, repository);
    assert.deepEqual(lifecycle.harnessProjection, {
      baseRef: 'main',
      headRef: CODEX_SYNC_BRANCH,
      author: `${CODEX_SYNC_BOT}[bot]`,
      sourceRepository: `qwts/${CODEX_SOURCE_REPO}`,
    });
    const pullRequest = harnessPullRequest({ headRepository: repository });
    const options = {
      repository,
      lifecycle,
      pullRequests: [pullRequest],
      changedFiles: managedHarnessFiles,
    };
    assert.equal(isGovernedHarnessProjection(options), true, repository);
    assert.deepEqual(releaseOutputs(options), {
      pull_request_kind: 'governed-harness-projection',
      generated_release_projection: 'false',
      governed_harness_projection: 'true',
      release_metadata_system: 'changesets',
      source_input_policy: lifecycle.sourceInputPolicy,
      release_gate_mode: 'harness-projection',
    });
  }
});

test('a harness sync stays no-release after an unrelated version PR consumes changesets and it rebases', () => {
  const beforeVersion = harnessPullRequest();
  const afterVersion = {
    ...beforeVersion,
    head: { ...beforeVersion.head, sha: 'f'.repeat(40) },
  };
  for (const pullRequest of [beforeVersion, afterVersion]) {
    assert.equal(releaseOutputs(releaseRun({
      pullRequests: [pullRequest],
      changedFiles: managedHarnessFiles,
    })).release_gate_mode, 'harness-projection');
  }
});

test('mixed paths, renamed product files, and invalid source provenance fail closed to source policy', () => {
  for (const [reason, pullRequest, changedFiles] of [
    ['wrong author', harnessPullRequest({ author: 'qwts' }), managedHarnessFiles],
    ['wrong head', harnessPullRequest({ headRef: 'codex/sync' }), managedHarnessFiles],
    ['wrong base', harnessPullRequest({ baseRef: 'next' }), managedHarnessFiles],
    ['wrong repository', harnessPullRequest({ headRepository: 'octocat/overlook' }), managedHarnessFiles],
    ['no changed files', harnessPullRequest(), []],
    ['product path', harnessPullRequest(), [...managedHarnessFiles, { filename: 'src/product.mjs' }]],
    ['renamed product path', harnessPullRequest(), [{ filename: '.codex/config.toml', previous_filename: 'src/product.mjs' }]],
    ['missing source', harnessPullRequest({ body: '' }), managedHarnessFiles],
    ['short source SHA', harnessPullRequest({ body: 'https://github.com/qwts/playbook-engineering/commit/abc123' }), managedHarnessFiles],
    ['wrong source repository', harnessPullRequest({ body: `https://github.com/qwts/other/commit/${harnessSource}` }), managedHarnessFiles],
    ['ambiguous source', harnessPullRequest({ body: [
      `https://github.com/qwts/playbook-engineering/commit/${harnessSource}`,
      `https://github.com/qwts/playbook-engineering/commit/${'a'.repeat(40)}`,
    ].join('\n') }), managedHarnessFiles],
  ]) {
    const options = releaseRun({ pullRequests: [pullRequest], changedFiles });
    assert.equal(isGovernedHarnessProjection(options), false, reason);
    assert.equal(releaseOutputs(options).release_gate_mode, 'source-policy', reason);
  }

  assert.throws(
    () => releaseOutputs(releaseRun({
      pullRequests: [harnessPullRequest(), source],
      changedFiles: managedHarnessFiles,
    })),
    /governed harness projection origin is ambiguous/,
  );
});

test('harness changed-file evidence comes from the complete GitHub pull-request diff', async () => {
  const requested = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ filename: `path-${index}` }));
  const changedFiles = await harnessProjectionChangedFiles(releaseRun({
    pullRequests: [harnessPullRequest()],
    apiUrl: 'https://github.example/api/v3',
    token: 'test-token',
    fetchImpl: async (url) => {
      requested.push(String(url));
      return { ok: true, json: async () => requested.length === 1 ? firstPage : managedHarnessFiles };
    },
  }));
  assert.deepEqual(changedFiles, [...firstPage, ...managedHarnessFiles]);
  assert.deepEqual(requested, [
    'https://github.example/api/v3/repos/qwts/overlook/pulls/27/files?per_page=100&page=1',
    'https://github.example/api/v3/repos/qwts/overlook/pulls/27/files?per_page=100&page=2',
  ]);
});

test('harness file-evidence failures retain ordinary source policy', async () => {
  const fullPage = Array.from({ length: 100 }, (_, index) => ({ filename: `path-${index}` }));
  for (const [reason, fetchImpl] of [
    ['HTTP failure', async () => ({ ok: false, status: 503 })],
    ['malformed response', async () => ({ ok: true, json: async () => ({ files: managedHarnessFiles }) })],
    ['complete-diff limit', async () => ({ ok: true, json: async () => fullPage })],
  ]) {
    const options = releaseRun({
      pullRequests: [harnessPullRequest()],
      apiUrl: 'https://github.example/api/v3',
      token: 'test-token',
      fetchImpl,
    });
    const changedFiles = await harnessProjectionChangedFiles(options);
    assert.deepEqual(changedFiles, [], reason);
    assert.equal(
      releaseOutputs({ ...options, changedFiles }).release_gate_mode,
      'source-policy',
      reason,
    );
  }
});

test('ordinary automation and unconfigured repositories get no generated-release exception', () => {
  const dependabot = releasePullRequest({
    author: 'dependabot[bot]',
    headRef: 'dependabot/npm_and_yarn/example',
  }).pull_request;
  assert.equal(releaseOutputs(releaseRun({ pullRequests: [dependabot] })).release_gate_mode, 'source-policy');

  const unversioned = releaseLifecycleFor(releaseCatalog, 'qwts/playbook-engineering');
  const outputs = releaseOutputs(releaseRun({ lifecycle: unversioned, pullRequests: [source] }));
  assert.equal(outputs.generated_release_projection, 'false');
  assert.equal(outputs.release_gate_mode, 'not-applicable');
});

test('the merge queue classifies its own head pull request, not the entries behind it', async () => {
  const event = { merge_group: { head_ref: 'refs/heads/gh-readonly-queue/main/pr-116-e8c01cbc4c17' } };
  assert.deepEqual(mergeGroupHeadPullRequest(event), { baseRef: 'main', number: 116 });
  const requested = [];
  const options = releaseRun({
    eventName: 'merge_group',
    event,
    apiUrl: 'https://api.github.example',
    token: 'test-token',
    fetchImpl: async (url) => {
      requested.push(String(url));
      return { ok: true, json: async () => source };
    },
  });
  const pullRequests = await resolveReleaseOrigins(options);
  assert.deepEqual(requested, ['https://api.github.example/repos/qwts/overlook/pulls/116']);
  assert.deepEqual(pullRequests, [source]);
  // A generated projection queued ahead of this source PR is never fetched, so it cannot
  // weaken the head PR's source policy.
  assert.equal(releaseOutputs({ ...options, pullRequests }).release_gate_mode, 'source-policy');
});

test('release-origin lookups preserve the GitHub Enterprise API base path', async () => {
  const sha = 'a'.repeat(40);
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    const json = String(url).includes('/commits/')
      ? [source]
      : String(url).includes('/files?')
        ? managedHarnessFiles
        : source;
    return { ok: true, json: async () => json };
  };
  const options = {
    repository: 'qwts/overlook',
    apiUrl: 'https://github.example/api/v3',
    token: 'test-token',
    fetchImpl,
  };

  await getPullRequest({ ...options, number: 116 });
  await listPullRequestsForCommit({ ...options, sha });
  await listPullRequestFiles({ ...options, number: 27 });

  assert.deepEqual(requested, [
    'https://github.example/api/v3/repos/qwts/overlook/pulls/116',
    `https://github.example/api/v3/repos/qwts/overlook/commits/${sha}/pulls?per_page=100`,
    'https://github.example/api/v3/repos/qwts/overlook/pulls/27/files?per_page=100&page=1',
  ]);
});

test('manual and post-merge lanes classify the exact commit through its associated pull requests', async () => {
  const commitLane = (pullRequests) => ({
    ...releaseRun({ eventName: 'workflow_dispatch' }),
    sha: 'a'.repeat(40),
    apiUrl: 'https://api.github.example',
    token: 'test-token',
    fetchImpl: async () => ({ ok: true, json: async () => pullRequests }),
  });

  for (const eventName of ['workflow_dispatch', 'push']) {
    const lane = { ...commitLane([projection]), eventName };
    const pullRequests = await resolveReleaseOrigins(lane);
    assert.equal(releaseOutputs({ ...lane, pullRequests }).release_gate_mode, 'generated-projection');

    // Ambiguous origins fail closed; several source origins stay on source policy.
    assert.throws(
      () => releaseOutputs({ ...lane, pullRequests: [projection, source] }),
      /generated release projection origin is ambiguous/,
    );
    assert.equal(
      releaseOutputs({ ...lane, pullRequests: [source, source] }).release_gate_mode,
      'source-policy',
    );

    // A commit with no associated PR is an absence of release context, not a policy failure:
    // manual preflight before a PR exists must not break the lane.
    assert.deepEqual(await resolveReleaseOrigins({ ...commitLane([]), eventName }), []);
    assert.equal(releaseOutputs({ ...lane, pullRequests: [] }).release_gate_mode, 'no-source-context');
  }
});

test('release-origin lookups fail closed on missing or malformed evidence', async () => {
  const base = {
    repository: 'qwts/overlook',
    sha: 'b'.repeat(40),
    apiUrl: 'https://api.github.example',
    token: 'test-token',
  };
  const responses = {
    forbidden: async () => ({ ok: false, status: 403 }),
    notAnArray: async () => ({ ok: true, json: async () => ({}) }),
    missingRefs: async () => ({ ok: true, json: async () => [{ number: 1 }] }),
  };
  await assert.rejects(() => listPullRequestsForCommit({ ...base, fetchImpl: responses.forbidden }), /HTTP 403/);
  await assert.rejects(() => listPullRequestsForCommit({ ...base, fetchImpl: responses.notAnArray }), /malformed data/);
  await assert.rejects(() => listPullRequestsForCommit({ ...base, fetchImpl: responses.missingRefs }), /malformed data/);
  await assert.rejects(
    () => listPullRequestsForCommit({ ...base, sha: 'not-a-sha', fetchImpl: responses.notAnArray }),
    /commit SHA is invalid/,
  );
  await assert.rejects(
    () => listPullRequestsForCommit({ ...base, token: '', fetchImpl: responses.notAnArray }),
    /token is missing/,
  );
  await assert.rejects(
    () => listPullRequestFiles({ ...base, number: 27, fetchImpl: responses.forbidden }),
    /HTTP 403/,
  );
  await assert.rejects(
    () => listPullRequestFiles({
      ...base,
      number: 27,
      fetchImpl: async () => ({
        ok: true,
        json: async () => [{ filename: '.codex/config.toml', previous_filename: '' }],
      }),
    }),
    /malformed data/,
  );
  await assert.rejects(
    () => listPullRequestFiles({
      ...base,
      number: 27,
      fetchImpl: async () => ({
        ok: true,
        json: async () => Array.from({ length: 100 }, (_, index) => ({ filename: `path-${index}` })),
      }),
    }),
    /complete-diff limit/,
  );
  await assert.rejects(
    () => resolveReleaseOrigins({
      ...base,
      eventName: 'merge_group',
      event: { merge_group: { head_ref: 'refs/heads/not-a-queue' } },
      lifecycle: overlook,
      fetchImpl: responses.notAnArray,
    }),
    /head ref .* is malformed/,
  );
});

test('the release lifecycle catalog is uniquely configured per governed repository', () => {
  assert.throws(() => releaseLifecycleFor(releaseCatalog, 'qwts/unlisted'), /not uniquely configured/);
  assert.throws(() => releaseLifecycleFor({ schemaVersion: 2, repositories: [] }, 'qwts/overlook'), /malformed/);
});

test('unauthorized bots and forks cannot claim the generated projection path', () => {
  const event = releasePullRequest({ author: 'chores-dumb[bot]', headRef: 'changeset-release/main' });
  assert.throws(
    () => classify({ actor: 'renovate[bot]', triggeringActor: 'renovate[bot]', eventName: 'pull_request', event }),
    /not authorized/,
  );
  assert.throws(
    () => classify({
      actor: 'qwts',
      eventName: 'pull_request',
      event: releasePullRequest({
        author: 'chores-dumb[bot]',
        headRef: 'changeset-release/main',
        headRepository: 'octocat/overlook',
        fork: true,
      }),
    }),
    /fork/,
  );
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
  assert.match(workflow, /generated_release_projection: \$\{\{ steps\.policy\.outputs\.generated_release_projection \}\}/);
  assert.match(workflow, /governed_harness_projection: \$\{\{ steps\.policy\.outputs\.governed_harness_projection \}\}/);
  assert.match(workflow, /release_gate_mode: \$\{\{ steps\.policy\.outputs\.release_gate_mode \}\}/);
  assert.match(workflow, /^  pull-requests: read$/m);
  assert.match(workflow, /CODEQL: \$\{\{ needs\.codeql\.result \}\}/);
  assert.match(workflow, /test "\$CODEQL" = success/);
  assert.match(workflow, /queue\|manual\)/);
  assert.match(workflow, /name: CI\n/);
  assert.doesNotMatch(workflow, /name: Draft checks/);

  const docsJob = workflow.match(/^  docs-gov:\n[\s\S]*?(?=^  dependency-inventory:$)/m)?.[0];
  const fullJob = workflow.match(/^  full:\n[\s\S]*?(?=^  docs-gov:$)/m)?.[0];
  const inventoryJob = workflow.match(/^  dependency-inventory:\n[\s\S]*?(?=^  codeql:$)/m)?.[0];
  assert.ok(docsJob, 'docs governance job is missing');
  assert.ok(fullJob, 'complete-suite job is missing');
  assert.ok(inventoryJob, 'dependency-inventory job is missing');
  assert.match(docsJob, /needs\.policy\.outputs\.run_full == 'true'/u);
  assert.doesNotMatch(docsJob, /preflight-evidence\.outputs\.validated/u);
  assert.match(fullJob, /preflight-evidence\.outputs\.validated != 'true'/u);
  assert.match(inventoryJob, /preflight-evidence\.outputs\.validated != 'true'/u);
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
