#!/usr/bin/env node
// Renders the body of the model-registry refresh issue (ENG-0151) from the
// registry itself, so the task always names the current sources and the exact
// slots that need confirming. Generated rather than hand-written for the same
// reason the routing is retrieved rather than recalled: a static checklist goes
// stale in precisely the way this whole mechanism exists to prevent.
//
//   node tools/models/refresh-task.mjs "<reason the refresh was triggered>"

import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadRegistry, staleness, TIERS, VENDOR_GROUPS } from './registry.mjs';

export function refreshTaskBody(registry, reason) {
  const { verified_at, seeded, unverified } = staleness(registry);
  const sources = Object.entries(registry.sources ?? {})
    .map(([group, url]) => `- \`${group}\` — ${url ?? '**no source pinned yet — find and record one**'}`)
    .join('\n');
  const policy = registry.policy?.chinese_models;

  return `Triggered because: ${reason}

Update \`governance/agent-models.json\` and open a PR. Do not commit directly.

## Sources

Read these, not memory. If a source is missing below, find the vendor's own model documentation, use it, and add the URL to \`sources\` in the same PR.

${sources}

## What to fill in

Every slot is \`{model, reasoning, status}\` for both \`plan\` and \`build\`, across tiers ${TIERS.join('/')} and vendor groups ${VENDOR_GROUPS.join(', ')}.

- **${unverified.length} slot(s) unverified** — never confirmed. These are the priority.
- **${seeded.length} slot(s) provisional** — written by hand at authoring time and never checked against vendor docs. Confirm or correct them.
- \`verified_at\` is currently **${verified_at ?? 'never'}**.

Set \`reasoning\` to the vendor's own control where one exists (an effort or thinking level), and \`available_in\` to where we can actually invoke the model. Availability is as load-bearing as the name: a recommendation naming something nobody here can invoke is worse than no recommendation.

## Rules

1. **Advance \`verified_at\` only on a successful read of the sources.** If a source could not be reached, leave it unchanged and say so in the PR. A fresh date over a failed run hides staleness behind a current-looking timestamp — the exact failure this registry exists to prevent.
2. **Leave a slot \`unverified\` with \`model: null\` rather than guessing.** A plausible model name is indistinguishable from a correct one to everyone downstream.
3. **${policy?.rule ?? 'Chinese models: IDE-mediated access only.'}** ${policy?.reason ?? ''} ${policy?.refresh_constraint ?? ''}
4. Run \`node tools/models/registry.mjs\` before opening the PR; it fails on a malformed or self-contradicting registry.

## Verify before claiming done

- \`npm test\` passes.
- \`node tools/models/registry.mjs\` prints the table with no validation errors.
- The PR body lists which sources were actually read and which, if any, were unreachable.
`;
}

function main() {
  const reason = process.argv[2];
  if (!reason) {
    process.stderr.write('refresh-task: a reason is required\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(refreshTaskBody(loadRegistry(), reason));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
