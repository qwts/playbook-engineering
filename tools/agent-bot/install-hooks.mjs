#!/usr/bin/env node
// Install the machine-wide agent-bot git hooks (ENG-0016 / ENG-0045).
// Points global core.hooksPath at THIS checkout's tools/agent-bot/hooks —
// never at a hard-coded ~/Code/... path — so a clone on another volume or
// under a different home layout still works. Run once per machine from the
// playbook-engineering checkout you intend to keep as the canonical copy:
//
//   node tools/agent-bot/install-hooks.mjs
//
// Re-run after moving the checkout; the new absolute path replaces the old.

import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  checkoutRootFromAgentBot,
  writePlaybookHome,
} from './playbook-home.mjs';

export function hooksDirectory(agentBotDir = dirname(fileURLToPath(import.meta.url))) {
  return join(agentBotDir, 'hooks');
}

export function installHooks({
  hooksPath = hooksDirectory(),
  playbookRoot = checkoutRootFromAgentBot(),
  run = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim(),
  exists = existsSync,
  writeHome = writePlaybookHome,
} = {}) {
  if (!exists(hooksPath)) {
    throw new Error(`hooks directory missing: ${hooksPath}`);
  }
  const playbook = writeHome(playbookRoot);
  let previous = null;
  try {
    previous = run(['config', '--global', '--path', '--get', 'core.hooksPath']) || null;
  } catch {
    /* unset */
  }
  run(['config', '--global', 'core.hooksPath', hooksPath]);
  return { hooksPath, previous, playbookRoot: playbook.root, playbookHomeFile: playbook.path };
}

function main() {
  const { hooksPath, previous, playbookRoot } = installHooks();
  if (previous && previous !== hooksPath) {
    process.stdout.write(`core.hooksPath: ${previous} -> ${hooksPath}\n`);
  } else if (previous === hooksPath) {
    process.stdout.write(`core.hooksPath already ${hooksPath}\n`);
  } else {
    process.stdout.write(`core.hooksPath -> ${hooksPath}\n`);
  }
  process.stdout.write(`playbook-home -> ${playbookRoot}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`install-hooks: ${err.message}`);
    process.exit(1);
  }
}
