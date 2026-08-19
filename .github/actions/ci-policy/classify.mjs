import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { GOVERNED_HARNESS_FILES } from '../../../tools/repos/lib/baseline-files.mjs';
import { listPullRequestFiles, resolveReleaseOrigins } from './release-origin.mjs';

const ROSTER_URL = new URL('../../../governance/agents.json', import.meta.url);
const RELEASE_LIFECYCLES_URL = new URL('../../../governance/release-lifecycles.json', import.meta.url);
const MERGE_QUEUE_ACTOR = 'github-merge-queue[bot]';

export function allowedActorsFromRoster(roster) {
  if (!Array.isArray(roster?.agents)) throw new Error('agent roster is malformed');
  const activeAgents = roster.agents
    .filter((agent) => agent.status === 'active')
    .map((agent) => `${agent.slug}[bot]`);
  return new Set(['qwts', 'chores-dumb[bot]', 'dependabot[bot]', ...activeAgents]);
}

export function isAllowedActor(actor, allowedActors) {
  return allowedActors.has(actor);
}

export function isNativeMergeQueueMainPush({ actor, triggeringActor, eventName, ref }) {
  return (
    actor === MERGE_QUEUE_ACTOR &&
    triggeringActor === MERGE_QUEUE_ACTOR &&
    eventName === 'push' &&
    ref === 'refs/heads/main'
  );
}

export function releaseLifecycleFor(catalog, repository) {
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.repositories)) {
    throw new Error('release lifecycle catalog is malformed');
  }
  const matches = catalog.repositories.filter((entry) => entry.repository === repository);
  if (matches.length !== 1) {
    throw new Error(`release lifecycle for ${repository || '<empty>'} is not uniquely configured`);
  }
  return matches[0];
}

function matchesProjectionIdentity(pullRequest, repository, projection) {
  return (
    pullRequest.base?.ref === projection.baseRef &&
    pullRequest.head?.ref === projection.headRef &&
    pullRequest.head?.repo?.full_name === repository &&
    pullRequest.user?.login === projection.author
  );
}

/**
 * Generated only when the run's single origin matches the reviewed projection identity.
 * A run carrying several origins with a projection among them is ambiguous and fails closed,
 * so an earlier projection can never waive a source PR's stricter policy.
 */
export function isGeneratedReleaseProjection({ repository, lifecycle, pullRequests }) {
  const projection = lifecycle.generatedProjection;
  if (!projection) return false;
  const generated = pullRequests.filter((pullRequest) =>
    matchesProjectionIdentity(pullRequest, repository, projection));
  if (generated.length === 0) return false;
  if (pullRequests.length !== 1) throw new Error('generated release projection origin is ambiguous');
  return true;
}

function sourceCommitFromBody(body, sourceRepository) {
  if (typeof body !== 'string' || typeof sourceRepository !== 'string') return null;
  const escapedRepository = sourceRepository.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const sourcePattern = new RegExp(
    `https://github\\.com/${escapedRepository}/commit/([0-9a-f]{40})(?=$|[\\s)])`,
    'giu',
  );
  const commits = new Set([...body.matchAll(sourcePattern)].map((match) => match[1].toLowerCase()));
  return commits.size === 1 ? [...commits][0] : null;
}

function isPureManagedHarnessDiff(changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return false;
  const managed = new Set(GOVERNED_HARNESS_FILES);
  return changedFiles.every((file) => {
    if (typeof file?.filename !== 'string' || !managed.has(file.filename)) return false;
    return file.previous_filename === undefined || (
      typeof file.previous_filename === 'string' && managed.has(file.previous_filename)
    );
  });
}

/**
 * Harness output is trusted only as one bot-owned origin with recorded source
 * provenance and a complete diff consisting exclusively of managed files.
 */
export function isGovernedHarnessProjection({
  repository,
  lifecycle,
  pullRequests,
  changedFiles,
}) {
  const projection = lifecycle.harnessProjection;
  if (!projection) return false;
  const matches = pullRequests.filter((pullRequest) =>
    matchesProjectionIdentity(pullRequest, repository, projection));
  if (matches.length === 0) return false;
  if (pullRequests.length !== 1) throw new Error('governed harness projection origin is ambiguous');
  if (!sourceCommitFromBody(matches[0].body, projection.sourceRepository)) return false;
  return isPureManagedHarnessDiff(changedFiles);
}

export async function harnessProjectionChangedFiles(options) {
  const projection = options.lifecycle.harnessProjection;
  if (!projection || options.pullRequests.length !== 1) return [];
  const [pullRequest] = options.pullRequests;
  if (!matchesProjectionIdentity(pullRequest, options.repository, projection)) return [];
  return listPullRequestFiles({ ...options, number: pullRequest.number });
}

export function releaseOutputs(options) {
  const generated = isGeneratedReleaseProjection(options);
  const harness = isGovernedHarnessProjection(options);
  const { metadataSystem, sourceInputPolicy } = options.lifecycle;
  const hasOrigin = options.pullRequests.length > 0;
  return {
    pull_request_kind:
      generated
        ? 'generated-release-projection'
        : harness
          ? 'governed-harness-projection'
          : hasOrigin
            ? 'change-pr'
            : 'not-a-pull-request',
    generated_release_projection: String(generated),
    governed_harness_projection: String(harness),
    release_metadata_system: metadataSystem,
    source_input_policy: sourceInputPolicy,
    release_gate_mode:
      metadataSystem === 'none'
        ? 'not-applicable'
        : generated
          ? 'generated-projection'
          : harness
            ? 'harness-projection'
            : hasOrigin
              ? 'source-policy'
              : 'no-source-context',
  };
}

export function authorizeRun({ actor, triggeringActor = actor, allowedActors, eventName, event, ref }) {
  const nativeMergeQueueMainPush = isNativeMergeQueueMainPush({
    actor,
    triggeringActor,
    eventName,
    ref,
  });
  if (!nativeMergeQueueMainPush) {
    if (!isAllowedActor(actor, allowedActors)) {
      throw new Error(`actor ${actor || '<empty>'} is not authorized by CI policy`);
    }
    if (!isAllowedActor(triggeringActor, allowedActors)) {
      throw new Error(`triggering actor ${triggeringActor || '<empty>'} is not authorized by CI policy`);
    }
  }
  if (eventName === 'pull_request' && event.pull_request?.head?.repo?.fork) {
    throw new Error('public fork pull requests are not permitted to run workflows');
  }
  if (eventName === 'pull_request_target' && event.pull_request?.head?.repo?.fork) {
    throw new Error('public fork pull requests are not permitted to run workflows');
  }
}

export function classifyRun(options) {
  authorizeRun(options);
  const { eventName, event, ref } = options;
  if (eventName === 'pull_request' && event.pull_request?.draft) {
    throw new Error('draft pull requests are validated locally and do not run CI');
  }
  if (eventName === 'pull_request') return 'full';
  if (eventName === 'merge_group') {
    const baseRef = event.merge_group?.base_ref;
    const headRef = event.merge_group?.head_ref;
    if (event.action !== 'checks_requested') {
      throw new Error(`merge_group action ${event.action || '<empty>'} is not supported`);
    }
    if (baseRef !== 'refs/heads/main' || !headRef?.startsWith('refs/heads/gh-readonly-queue/main/')) {
      throw new Error(`merge_group refs ${headRef || '<empty>'} -> ${baseRef || '<empty>'} are not governed`);
    }
    return 'queue';
  }
  if (eventName === 'push' && ref === 'refs/heads/main') return 'post-merge';
  if (eventName === 'workflow_dispatch') return 'manual';
  throw new Error(`event ${eventName || '<empty>'} on ${ref || '<empty>'} is not a governed CI trigger`);
}

export function outputsFor(mode, release = {}) {
  return {
    mode,
    run_full: String(mode === 'full' || mode === 'queue' || mode === 'manual'),
    run_post_merge: String(mode === 'post-merge'),
    ...release,
  };
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.CI_POLICY_EVENT_PATH, 'utf8'));
  const roster = JSON.parse(readFileSync(ROSTER_URL, 'utf8'));
  const options = {
    actor: process.env.CI_POLICY_ACTOR,
    triggeringActor: process.env.CI_POLICY_TRIGGERING_ACTOR,
    allowedActors: allowedActorsFromRoster(roster),
    eventName: process.env.CI_POLICY_EVENT_NAME,
    event,
    repository: process.env.CI_POLICY_REPOSITORY,
    ref: process.env.CI_POLICY_REF,
  };
  // Authorization-only callers gate on the actor alone; they neither read release
  // configuration nor hold `pull-requests: read`.
  if (process.env.CI_POLICY_AUTHORIZATION_ONLY === 'true') {
    authorizeRun(options);
    return writeOutputs(outputsFor('authorized'));
  }
  const mode = classifyRun(options);
  const catalog = JSON.parse(readFileSync(RELEASE_LIFECYCLES_URL, 'utf8'));
  const lifecycle = releaseLifecycleFor(catalog, options.repository);
  const pullRequests = await resolveReleaseOrigins({
    ...options,
    lifecycle,
    sha: process.env.CI_POLICY_SHA,
    apiUrl: process.env.CI_POLICY_API_URL,
    token: process.env.CI_POLICY_TOKEN,
  });
  const changedFiles = await harnessProjectionChangedFiles({
    ...options,
    lifecycle,
    pullRequests,
    apiUrl: process.env.CI_POLICY_API_URL,
    token: process.env.CI_POLICY_TOKEN,
  });
  writeOutputs(outputsFor(mode, releaseOutputs({ ...options, lifecycle, pullRequests, changedFiles })));
}

function writeOutputs(outputs) {
  const output = Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join('\n');
  appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
