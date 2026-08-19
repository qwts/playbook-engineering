#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderUninstalledIdentityCommand } from './lib/uninstalled-identity-adapter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADAPTERS = [
  { dialect: 'claude', path: '.claude/settings.json' },
  { dialect: 'codex', path: '.codex/hooks.json' },
  { dialect: 'cursor', path: '.cursor/hooks.json' },
];
const write = process.argv.slice(2).includes('--write');

function replacePreCommand(value, desired) {
  let replacements = 0;
  function visit(candidate) {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    if (
      typeof candidate.command === 'string'
      && candidate.command.includes('agent-bot agent-hook')
      && candidate.command.includes('--event pre-command')
    ) {
      candidate.command = desired;
      replacements += 1;
    }
    for (const child of Object.values(candidate)) visit(child);
  }
  visit(value);
  if (replacements !== 1) {
    throw new Error(`expected exactly one managed pre-command adapter, found ${replacements}`);
  }
}

let stale = false;
for (const adapter of ADAPTERS) {
  const absolute = path.join(ROOT, adapter.path);
  const current = readFileSync(absolute, 'utf8');
  const value = JSON.parse(current);
  replacePreCommand(value, renderUninstalledIdentityCommand(adapter.dialect));
  const desired = `${JSON.stringify(value, null, 2)}\n`;
  if (current === desired) continue;
  stale = true;
  if (write) writeFileSync(absolute, desired);
  else console.error(`${adapter.path} has stale uninstalled identity fallback logic`);
}

if (stale && !write) {
  console.error('Run: node tools/repos/uninstalled-identity-adapter.mjs --write');
  process.exit(1);
}
