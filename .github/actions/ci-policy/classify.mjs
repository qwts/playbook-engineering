import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const AGENT_ACTOR = /^qwts-[a-z0-9-]+-agent\[bot\]$/;

export function isAllowedActor(actor) {
  return actor === 'qwts' || actor === 'chores-dumb[bot]' || AGENT_ACTOR.test(actor);
}

export function classifyRun({ actor, eventName, event, ref }) {
  if (!isAllowedActor(actor)) throw new Error(`actor ${actor || '<empty>'} is not authorized by CI policy`);
  if (eventName === 'pull_request' && event.pull_request?.head?.repo?.fork) {
    throw new Error('public fork pull requests are not permitted to run workflows');
  }
  if (eventName === 'pull_request' && event.pull_request?.draft) {
    throw new Error('draft pull requests are validated locally and do not run CI');
  }
  if (eventName === 'pull_request') return 'full';
  if (eventName === 'merge_group') return 'full';
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
  const mode = classifyRun({
    actor: process.env.CI_POLICY_ACTOR,
    eventName: process.env.CI_POLICY_EVENT_NAME,
    event,
    ref: process.env.CI_POLICY_REF,
  });
  const output = Object.entries(outputsFor(mode)).map(([key, value]) => `${key}=${value}`).join('\n');
  appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
