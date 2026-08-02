import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolveReleasePullRequests } from './release-origin.mjs';

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

function releasePullRequests({ eventName, event, pullRequests = [] }) {
  if (pullRequests.length > 0) return pullRequests;
  return eventName === 'pull_request' && event.pull_request ? [event.pull_request] : [];
}

function matchesGeneratedProjection(pullRequest, repository, projection) {
  return (
    pullRequest.base?.ref === projection.baseRef &&
    pullRequest.head?.ref === projection.headRef &&
    pullRequest.head?.repo?.full_name === repository &&
    pullRequest.user?.login === projection.author
  );
}

export function isGeneratedReleaseProjection(options) {
  const { repository, lifecycle } = options;
  const projection = lifecycle.generatedProjection;
  if (!projection) return false;
  return releasePullRequests(options).some((pullRequest) =>
    matchesGeneratedProjection(pullRequest, repository, projection));
}

export function releaseOutputs(options) {
  const generated = isGeneratedReleaseProjection(options);
  const metadataSystem = options.lifecycle.metadataSystem;
  const hasPullRequest = releasePullRequests(options).length > 0;
  return {
    pull_request_kind:
      generated ? 'generated-release-projection' : hasPullRequest ? 'change-pr' : 'not-a-pull-request',
    generated_release_projection: String(generated),
    release_metadata_system: metadataSystem,
    source_input_policy: options.lifecycle.sourceInputPolicy,
    release_gate_mode:
      metadataSystem === 'none'
        ? 'not-applicable'
        : generated
          ? 'generated-projection'
          : hasPullRequest
            ? 'source-policy'
            : 'no-source-context',
  };
}

export function releaseGateOutcome({
  metadataSystem,
  generatedReleaseProjection,
  sourceRequirementApplies,
  sourceInputsValid,
  semanticReleaseCount,
}) {
  if (metadataSystem === 'none') return 'not-applicable';
  if (generatedReleaseProjection) {
    return semanticReleaseCount === 0 ? 'pass-generated-projection' : 'fail-generated-pending-releases';
  }
  if (!sourceRequirementApplies) return 'pass-source-inputs-not-required';
  return sourceInputsValid ? 'pass-source-inputs' : 'fail-source-inputs';
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
  const catalog = JSON.parse(readFileSync(RELEASE_LIFECYCLES_URL, 'utf8'));
  const options = {
    actor: process.env.CI_POLICY_ACTOR,
    triggeringActor: process.env.CI_POLICY_TRIGGERING_ACTOR,
    allowedActors: allowedActorsFromRoster(roster),
    eventName: process.env.CI_POLICY_EVENT_NAME,
    event,
    repository: process.env.CI_POLICY_REPOSITORY,
    ref: process.env.CI_POLICY_REF,
  };
  const lifecycle = releaseLifecycleFor(catalog, options.repository);
  const authorizationOnly = process.env.CI_POLICY_AUTHORIZATION_ONLY === 'true';
  const mode = authorizationOnly ? 'authorized' : classifyRun(options);
  if (authorizationOnly) authorizeRun(options);
  const pullRequests = authorizationOnly
    ? releasePullRequests(options)
    : await resolveReleasePullRequests({
        ...options,
        lifecycle,
        sha: process.env.CI_POLICY_SHA,
        apiUrl: process.env.CI_POLICY_API_URL,
        graphqlUrl: process.env.CI_POLICY_GRAPHQL_URL,
        token: process.env.CI_POLICY_TOKEN,
      });
  const release = releaseOutputs({ ...options, lifecycle, pullRequests });
  const output = Object.entries(outputsFor(mode, release)).map(([key, value]) => `${key}=${value}`).join('\n');
  appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
