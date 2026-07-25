#!/usr/bin/env node
// Install the gh shim (ENG-0045: PRs and comments as the worktree's bot,
// automatically). Writes ~/.config/agent-bot/bin/gh and adds an idempotent
// PATH line to ~/.zshenv. Run once per machine, from this checkout:
//
//   node tools/agent-bot/install-gh-shim.mjs
//
// Shim behavior: a true human shell outside bot territory is a pure
// passthrough to the real gh. An agent process outside bot territory aborts
// before stock gh can exercise the human credential. Inside a bot worktree it
// resolves the bot from the worktree's own config, mints a cached token, and
// exports GH_TOKEN. If the mint fails it ABORTS: it never falls back to the
// human. New shells pick up the PATH line; processes that never read ~/.zshenv
// still keep stock gh, so launchers must preserve the shim path.

import { mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGhShim } from './gh-shim.mjs';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const tokenTool = join(toolsDir, 'worktree-token.mjs');

const SHIM = buildGhShim(tokenTool);

const binDir = join(homedir(), '.config', 'agent-bot', 'bin');
mkdirSync(binDir, { recursive: true });
writeFileSync(join(binDir, 'gh'), SHIM, { mode: 0o755 });
console.log(`gh shim -> ${join(binDir, 'gh')} (token tool: ${tokenTool})`);

const zshenv = join(homedir(), '.zshenv');
const pathLine = 'export PATH="$HOME/.config/agent-bot/bin:$PATH"  # agent-bot gh shim (ENG-0045)';
let body = '';
try {
  body = readFileSync(zshenv, 'utf8');
} catch {
  /* no ~/.zshenv yet */
}
if (!body.includes('.config/agent-bot/bin')) {
  appendFileSync(zshenv, `\n${pathLine}\n`);
  console.log(`PATH line appended to ${zshenv} (new shells pick it up)`);
} else {
  console.log('PATH line already present in ~/.zshenv');
}
