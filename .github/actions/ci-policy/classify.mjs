import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROSTER_URL = new URL('../../../governance/agents.json', import.meta.url);

export function allowedActorsFromRoster(roster) {
  if (!Array.isArray(roster?.agents)) throw new Error('agent roster is malformed');
  const activeAgents = roster.agents
    .filter((agent) => agent.status === 'active')
    .map((agent) => `${agent.slug}[bot]`);
  return new Set(['qwts', 'chores-dumb[bot]', ...activeAgents]);
}

export function isAllowedActor(actor, allowedActors) {
  return allowedActors.has(actor);
}

export function classifyRun({ actor, triggeringActor = actor, allowedActors, eventName, event, ref }) {
  if (!isAllowedActor(actor, allowedActors)) {
    throw new Error(`actor ${actor || '<empty>'} is not authorized by CI policy`);
  }
  if (!isAllowedActor(triggeringActor, allowedActors)) {
    throw new Error(`triggering actor ${triggeringActor || '<empty>'} is not authorized by CI policy`);
  }
  if (eventName === 'pull_request' && event.pull_request?.head?.repo?.fork) {
    throw new Error('public fork pull requests are not permitted to run workflows');
  }
  if (eventName === 'pull_request' && event.pull_request?.draft) {
    throw new Error('draft pull requests are validated locally and do not run CI');
  }
  if (eventName === 'pull_request') return 'full';
  if (eventName === 'push' && ref === 'refs/heads/main') return 'post-merge';
  if (eventName === 'workflow_dispatch') return 'manual';
  throw new Error(`event ${eventName || '<empty>'} on ${ref || '<empty>'} is not a governed CI trigger`);
}

export function outputsFor(mode) {
  return {
    mode,
    run_full: String(mode === 'full' || mode === 'manual'),
    run_post_merge: String(mode === 'post-merge'),
  };
}

function main() {
  const event = JSON.parse(readFileSync(process.env.CI_POLICY_EVENT_PATH, 'utf8'));
  const roster = JSON.parse(readFileSync(ROSTER_URL, 'utf8'));
  const mode = classifyRun({
    actor: process.env.CI_POLICY_ACTOR,
    triggeringActor: process.env.CI_POLICY_TRIGGERING_ACTOR,
    allowedActors: allowedActorsFromRoster(roster),
    eventName: process.env.CI_POLICY_EVENT_NAME,
    event,
    ref: process.env.CI_POLICY_REF,
  });
  const output = Object.entries(outputsFor(mode)).map(([key, value]) => `${key}=${value}`).join('\n');
  appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
