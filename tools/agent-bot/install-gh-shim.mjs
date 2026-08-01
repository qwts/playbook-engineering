#!/usr/bin/env node
// Install the gh shim (ENG-0045: PRs and comments as the worktree's bot,
// automatically). Writes ~/.config/agent-bot/bin/gh, records this checkout in
// ~/.config/agent-bot/playbook-home, symlinks into ~/.local/bin (already on
// Cursor/agent PATHs), and adds an idempotent PATH line to ~/.zshenv. Run
// once per machine — and again after moving the checkout:
//
//   node tools/agent-bot/install-gh-shim.mjs
//
// Shim behavior: a true human shell outside bot territory is a pure
// passthrough to the real gh. An agent process outside bot territory aborts
// before stock gh can exercise the human credential. Inside a bot worktree it
// resolves the bot from the worktree's own config, mints a cached token, and
// exports GH_TOKEN. If the mint fails it ABORTS: it never falls back to the
// human.

import process from 'node:process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildGhShim } from './gh-shim.mjs';
import {
  agentBotConfigDir,
  checkoutRootFromAgentBot,
  writePlaybookHome,
} from './playbook-home.mjs';

export function installGhShim({
  home = homedir(),
  playbookRoot = checkoutRootFromAgentBot(),
  mkdir = mkdirSync,
  write = writeFileSync,
  read = readFileSync,
  append = appendFileSync,
  symlink = symlinkSync,
  rm = rmSync,
} = {}) {
  const { path: playbookHomeFile, root } = writePlaybookHome(playbookRoot, {
    home,
    mkdir,
    write,
  });

  const binDir = join(agentBotConfigDir(home), 'bin');
  mkdir(binDir, { recursive: true });
  const shimPath = join(binDir, 'gh');
  write(shimPath, buildGhShim(), { mode: 0o755 });

  const localBin = join(home, '.local', 'bin');
  mkdir(localBin, { recursive: true });
  const localShim = join(localBin, 'gh');
  // Prefer a symlink so reinstalling the config-dir shim is enough; replace
  // any prior file/symlink at ~/.local/bin/gh.
  rm(localShim, { force: true });
  symlink(shimPath, localShim);

  const zshenv = join(home, '.zshenv');
  const pathLine = 'export PATH="$HOME/.config/agent-bot/bin:$PATH"  # agent-bot gh shim (ENG-0045)';
  let body = '';
  try {
    body = read(zshenv, 'utf8');
  } catch {
    /* no ~/.zshenv yet */
  }
  let zshenvUpdated = false;
  if (!body.includes('.config/agent-bot/bin')) {
    append(zshenv, `${body.endsWith('\n') || body === '' ? '' : '\n'}\n${pathLine}\n`);
    zshenvUpdated = true;
  }

  return {
    shimPath,
    localShim,
    playbookHomeFile,
    playbookRoot: root,
    zshenvUpdated,
    zshenv,
  };
}

function main() {
  const result = installGhShim();
  process.stdout.write(`gh shim -> ${result.shimPath}\n`);
  process.stdout.write(`playbook-home -> ${result.playbookRoot} (${result.playbookHomeFile})\n`);
  process.stdout.write(`PATH shim -> ${result.localShim}\n`);
  if (result.zshenvUpdated) {
    process.stdout.write(`PATH line appended to ${result.zshenv}\n`);
  } else {
    process.stdout.write(`PATH line already present in ${result.zshenv}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`install-gh-shim: ${err.message}`);
    process.exit(1);
  }
}
