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
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  installLauncher,
} from './playbook-launcher.mjs';

export function hooksDirectory(agentBotDir = dirname(fileURLToPath(import.meta.url))) {
  return join(agentBotDir, 'hooks');
}

export function installHooks({
  hooksPath = hooksDirectory(),
  playbookRoot,
  home = homedir(),
  run = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim(),
  exists = existsSync,
  stat = statSync,
  install = installLauncher,
  mkdir = mkdirSync,
  list = readdirSync,
  write = writeFileSync,
} = {}) {
  if (!exists(hooksPath)) {
    throw new Error(`hooks directory missing: ${hooksPath}`);
  }
  // core.hooksPath must point at a directory; a file would install silently
  // broken (Git ignores it or behaves unexpectedly).
  if (!stat(hooksPath).isDirectory()) {
    throw new Error(`core.hooksPath must be a directory, not a file: ${hooksPath}`);
  }
  const installed = install({ home, ...(playbookRoot ? { root: playbookRoot } : {}) });
  const wrapperDir = join(home, '.local', 'share', 'playbook-engineering', 'hooks');
  mkdir(wrapperDir, { recursive: true });
  for (const name of list(hooksPath)) {
    if (name === 'chain-hook') continue;
    const source = join(hooksPath, name);
    if (!stat(source).isFile()) continue;
    write(join(wrapperDir, name), `#!/bin/sh\nexec "\${HOME}/.local/bin/playbook-engineering" run tools/agent-bot/hooks/${name} -- "$@"\n`, { mode: 0o755 });
  }
  let previous = null;
  try {
    previous = run(['config', '--global', '--path', '--get', 'core.hooksPath']) || null;
  } catch {
    /* unset */
  }
  run(['config', '--global', 'core.hooksPath', wrapperDir]);
  return { hooksPath: wrapperDir, previous, playbookRoot: installed.path, sha: installed.sha };
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
  process.stdout.write(`playbook-engineering -> ${playbookRoot}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`install-hooks: ${err.message}`);
    process.exit(1);
  }
}
