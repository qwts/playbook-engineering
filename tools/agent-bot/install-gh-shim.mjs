#!/usr/bin/env node
// Install the gh shim (ENG-0045: PRs and comments as the worktree's bot,
// automatically). Writes ~/.config/agent-bot/bin/gh and adds an idempotent
// PATH line to ~/.zshenv. Run once per machine, from this checkout:
//
//   node tools/agent-bot/install-gh-shim.mjs
//
// Shim behavior: outside bot territory (or with GH_TOKEN already set) it is a
// pure passthrough to the real gh — the human's gh use never changes. Inside
// a bot worktree it resolves the bot from the worktree's own config, mints a
// cached token, and exports GH_TOKEN. If the mint fails it ABORTS: it never
// falls back to the human. New shells pick up the PATH line; processes that
// never read ~/.zshenv keep stock gh (fail-open — ENG-0045 decision 4 is the
// backstop).

import { mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const tokenTool = join(toolsDir, 'worktree-token.mjs');

const SHIM = `#!/bin/sh
# gh shim — agent bot identity (ENG-0045). Managed by
# ${join(toolsDir, 'install-gh-shim.mjs')}; do not edit in place.
TOKEN_TOOL="${tokenTool}"
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REAL=""
OLDIFS=$IFS; IFS=:
for d in $PATH; do
  [ "$d" = "$SELF_DIR" ] && continue
  if [ -x "$d/gh" ]; then REAL="$d/gh"; break; fi
done
IFS=$OLDIFS
[ -z "$REAL" ] && { echo "agent-bot gh shim: real gh not found on PATH" >&2; exit 127; }
# gh whoami: who will gh act as HERE, stated plainly. Stock gh has no such
# subcommand, so intercepting it shadows nothing. No mint, no network for
# the bot answer; the human answer asks GitHub (same as gh api user).
if [ "$1" = "whoami" ]; then
  if [ -f "$TOKEN_TOOL" ] && command -v node >/dev/null 2>&1; then
    SLUG=$(node "$TOKEN_TOOL" --slug 2>/dev/null)
    if [ -n "$SLUG" ]; then echo "${SLUG}[bot] — bot territory (ENG-0045)"; exit 0; fi
  fi
  echo "$("$REAL" api user --jq .login 2>/dev/null || echo 'unknown') — human territory, gh is stock"
  exit 0
fi
if [ -z "$GH_TOKEN" ] && [ -f "$TOKEN_TOOL" ] && command -v node >/dev/null 2>&1; then
  TOKEN=$(node "$TOKEN_TOOL") || {
    echo "agent-bot: token mint failed in a bot worktree — refusing to run gh as the human" >&2
    exit 1
  }
  if [ -n "$TOKEN" ]; then GH_TOKEN="$TOKEN"; export GH_TOKEN; fi
fi
exec "$REAL" "$@"
`;

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
