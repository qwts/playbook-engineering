#!/usr/bin/env node
// Ensure ~/.config/<slug>/private-key.pem exists by pulling it from Proton Pass
// (ENG-0016). Vault title is fixed; the item title is the agent slug
// (e.g. qwts-cursor-agent). Idempotent unless --force: a present key is left
// alone. Runnable on its own — no worktree setup required.
//
//   node tools/agent-bot/ensure-private-key.mjs [app-slug] [--force]
//
// Slug resolution matches the rest of agent-bot: explicit arg, then
// $GH_AGENT_APP, then git pin / harness detection.
//
//   pass-cli item view --vault-name "Agent Identities" --item-title <slug> --output json
//   pass-cli item attachment download --share-id … --item-id … --attachment-id … \
//     --output ~/.config/<slug>/private-key.pem

import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveAgentSlug } from './resolve-agent.mjs';

export const AGENT_IDENTITIES_VAULT = 'Agent Identities';

function requireSlug(slug) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(slug)) {
    throw new Error(`invalid GitHub App slug: ${JSON.stringify(slug)}`);
  }
  return slug;
}

export function privateKeyPath(slug, home = homedir()) {
  return join(home, '.config', requireSlug(slug), 'private-key.pem');
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  let force = false;
  let explicit = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (arg === '--app') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('--app requires a slug, e.g. --app qwts-cursor-agent');
      }
      explicit = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`unknown flag: ${arg}`);
    }
    if (explicit) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    explicit = arg;
  }
  return { force, explicit };
}

function pickString(...candidates) {
  for (const value of candidates) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function attachmentName(attachment) {
  if (!attachment || typeof attachment !== 'object') return '';
  return pickString(
    attachment.name,
    attachment.fileName,
    attachment.filename,
    attachment.content?.name,
    attachment.content?.fileName,
    attachment.content?.filename,
  ) ?? '';
}

function attachmentId(attachment) {
  if (!attachment || typeof attachment !== 'object') return null;
  return pickString(attachment.id, attachment.attachmentId, attachment.attachment_id);
}

export function parsePassItemView(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`pass-cli item view returned non-JSON: ${err.message}`);
  }

  const item = data?.item && typeof data.item === 'object' ? data.item : data;
  const shareId = pickString(
    data?.shareId,
    data?.share_id,
    data?.ShareID,
    item?.shareId,
    item?.share_id,
    item?.ShareID,
  );
  const itemId = pickString(
    data?.itemId,
    data?.item_id,
    item?.id,
    item?.itemId,
    item?.item_id,
  );
  const attachments = Array.isArray(data?.attachments)
    ? data.attachments
    : Array.isArray(item?.attachments)
      ? item.attachments
      : [];

  if (!shareId || !itemId) {
    throw new Error('pass-cli item view JSON lacked share-id or item-id');
  }

  return {
    shareId,
    itemId,
    attachments: attachments.map((attachment) => ({
      id: attachmentId(attachment),
      name: attachmentName(attachment),
    })).filter((attachment) => attachment.id),
  };
}

export function selectPrivateKeyAttachment(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    throw new Error('pass-cli item has no downloadable attachments');
  }
  const byExact = attachments.find((a) => a.name === 'private-key.pem');
  if (byExact) return byExact;
  const byPem = attachments.filter((a) => a.name.toLowerCase().endsWith('.pem'));
  if (byPem.length === 1) return byPem[0];
  if (attachments.length === 1) return attachments[0];
  const names = attachments.map((a) => a.name || a.id).join(', ');
  throw new Error(`pass-cli item has multiple attachments; expected private-key.pem (found: ${names})`);
}

function defaultRun(args) {
  try {
    return execFileSync('pass-cli', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = [err.stderr, err.stdout, err.message].filter(Boolean).join('\n').trim();
    throw new Error(`pass-cli ${args[0]} ${args[1] ?? ''} failed: ${detail}`);
  }
}

export function ensurePrivateKey({
  slug,
  force = false,
  home = homedir(),
  run = defaultRun,
  exists = existsSync,
  mkdir = mkdirSync,
  chmod = chmodSync,
} = {}) {
  const path = privateKeyPath(slug, home);
  if (!force && exists(path)) return { path, downloaded: false };

  const viewJson = run([
    'item',
    'view',
    '--vault-name',
    AGENT_IDENTITIES_VAULT,
    '--item-title',
    requireSlug(slug),
    '--output',
    'json',
  ]);
  const { shareId, itemId, attachments } = parsePassItemView(viewJson);
  const attachment = selectPrivateKeyAttachment(attachments);

  mkdir(dirname(path), { recursive: true });
  run([
    'item',
    'attachment',
    'download',
    '--share-id',
    shareId,
    '--item-id',
    itemId,
    '--attachment-id',
    attachment.id,
    '--output',
    path,
  ]);
  chmod(path, 0o600);
  return { path, downloaded: true };
}

function main() {
  const { force, explicit } = parseCliArgs();
  const slug = resolveAgentSlug({ explicit });
  if (!slug) {
    throw new Error(
      'pass an app slug, set GH_AGENT_APP, or run from a pinned/detected agent environment — see docs/reference/agent-bot-operations.md',
    );
  }
  const result = ensurePrivateKey({ slug, force });
  if (result.downloaded) {
    process.stdout.write(`${force ? 'refreshed' : 'fetched'} ${result.path}\n`);
  } else {
    process.stdout.write(`already present ${result.path} (pass --force to refresh)\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`ensure-private-key: ${err.message}`);
    process.exit(1);
  }
}
