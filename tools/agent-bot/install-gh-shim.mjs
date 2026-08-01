#!/usr/bin/env node
// Install the gh shim (ENG-0045: PRs and comments as the worktree's bot,
// automatically). Installs the commit-pinned playbook launcher, writes
// ~/.config/agent-bot/bin/gh, and symlinks it into ~/.local/bin. Run
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
  lstatSync,
  readlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildGhShim } from './gh-shim.mjs';
import {
  installLauncher,
} from './playbook-launcher.mjs';

export function installGhShim({
  home = homedir(),
  playbookRoot,
  mkdir = mkdirSync,
  write = writeFileSync,
  read = readFileSync,
  append = appendFileSync,
  symlink = symlinkSync,
  rm = rmSync,
  lstat = lstatSync,
  readlink = readlinkSync,
  install = installLauncher,
} = {}) {
  const installed = install({ home, ...(playbookRoot ? { root: playbookRoot } : {}) });

  const binDir = join(home, '.config', 'agent-bot', 'bin');
  mkdir(binDir, { recursive: true });
  const shimPath = join(binDir, 'gh');
  write(shimPath, buildGhShim(), { mode: 0o755 });

  const localBin = join(home, '.local', 'bin');
  mkdir(localBin, { recursive: true });
  const localShim = join(localBin, 'gh');
  // Only replace an agent-bot-owned symlink. A real gh CLI installed at
  // ~/.local/bin/gh must not be deleted — abort and ask the user to move it,
  // so the shim's PATH-skip can still find stock gh as a passthrough target.
  let stat;
  try {
    stat = lstat(localShim);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (stat) {
    if (stat.isSymbolicLink()) {
      let target = readlink(localShim);
      if (!target.startsWith('/')) target = join(localBin, target);
      const agentBin = join(home, '.config', 'agent-bot', 'bin');
      if (target === shimPath || target.startsWith(`${agentBin}/`)) {
        rm(localShim, { force: true });
      } else {
        throw new Error(
          `~/.local/bin/gh is a symlink to ${target}, not an agent-bot shim — ` +
            'remove it manually if you want the agent-bot shim there',
        );
      }
    } else {
      throw new Error(
        '~/.local/bin/gh is a real file (likely the GitHub CLI) — move it elsewhere ' +
          'before installing the agent-bot shim, so stock gh stays reachable',
      );
    }
  }
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
    playbookRoot: installed.path,
    sha: installed.sha,
    zshenvUpdated,
    zshenv,
  };
}

function main() {
  const result = installGhShim();
  process.stdout.write(`gh shim -> ${result.shimPath}\n`);
  process.stdout.write(`playbook-engineering -> ${result.playbookRoot} at ${result.sha}\n`);
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
