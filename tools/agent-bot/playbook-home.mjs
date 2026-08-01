// Canonical playbook-engineering checkout pointer for machine-wide agent-bot
// installs (ENG-0004 / ENG-0045). Written by install-hooks / install-gh-shim
// from the checkout they ran in — never assumed to be ~/Code/...
//
// Consumers (gh shim, docs) resolve tools via:
//   $PLAYBOOK_HOME/tools/agent-bot/...
//   or $(cat ~/.config/agent-bot/playbook-home)/tools/agent-bot/...

import process from 'node:process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function agentBotConfigDir(home = homedir()) {
  return join(home, '.config', 'agent-bot');
}

export function playbookHomePath(home = homedir()) {
  return join(agentBotConfigDir(home), 'playbook-home');
}

export function checkoutRootFromAgentBot(agentBotDir = dirname(fileURLToPath(import.meta.url))) {
  // tools/agent-bot -> repo root
  return join(agentBotDir, '..', '..');
}

export function writePlaybookHome(
  root = checkoutRootFromAgentBot(),
  { home = homedir(), mkdir = mkdirSync, write = writeFileSync } = {},
) {
  const configDir = agentBotConfigDir(home);
  mkdir(configDir, { recursive: true });
  const path = playbookHomePath(home);
  write(path, `${root}\n`, { mode: 0o644 });
  return { path, root };
}

export function readPlaybookHome({
  home = homedir(),
  env = process.env,
  read = readFileSync,
} = {}) {
  if (env.PLAYBOOK_HOME) return env.PLAYBOOK_HOME;
  try {
    return read(playbookHomePath(home), 'utf8').trim() || null;
  } catch {
    return null;
  }
}
