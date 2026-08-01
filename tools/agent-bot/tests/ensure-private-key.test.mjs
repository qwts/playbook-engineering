import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGENT_IDENTITIES_VAULT,
  ensurePrivateKey,
  parseCliArgs,
  parsePassItemView,
  privateKeyPath,
  selectPrivateKeyAttachment,
} from '../ensure-private-key.mjs';

const SAMPLE_VIEW = {
  item: {
    id: 'item-abc',
    share_id: 'share-xyz',
    content: { title: 'qwts-cursor-agent' },
  },
  attachments: [
    {
      id: 'att-pem',
      content: { name: 'private-key.pem', mime_type: 'application/x-pem-file' },
      size: 1704,
    },
    {
      id: 'att-other',
      content: { name: 'notes.txt', mime_type: 'text/plain' },
      size: 12,
    },
  ],
};

test('privateKeyPath nests under ~/.config/<slug>', () => {
  assert.equal(
    privateKeyPath('qwts-cursor-agent', '/home/agent'),
    '/home/agent/.config/qwts-cursor-agent/private-key.pem',
  );
});

test('parsePassItemView reads snake_case share/item/attachment ids', () => {
  const parsed = parsePassItemView(JSON.stringify(SAMPLE_VIEW));
  assert.equal(parsed.shareId, 'share-xyz');
  assert.equal(parsed.itemId, 'item-abc');
  assert.deepEqual(parsed.attachments, [
    { id: 'att-pem', name: 'private-key.pem' },
    { id: 'att-other', name: 'notes.txt' },
  ]);
});

test('parsePassItemView accepts camelCase keys', () => {
  const parsed = parsePassItemView(JSON.stringify({
    item: { id: 'item-1', shareId: 'share-1' },
    attachments: [{ id: 'a1', name: 'private-key.pem' }],
  }));
  assert.equal(parsed.shareId, 'share-1');
  assert.equal(parsed.itemId, 'item-1');
  assert.equal(parsed.attachments[0].name, 'private-key.pem');
});

test('selectPrivateKeyAttachment prefers private-key.pem', () => {
  const chosen = selectPrivateKeyAttachment([
    { id: 'a', name: 'notes.txt' },
    { id: 'b', name: 'private-key.pem' },
  ]);
  assert.equal(chosen.id, 'b');
});

test('selectPrivateKeyAttachment accepts a sole .pem when the exact name is absent', () => {
  const chosen = selectPrivateKeyAttachment([
    { id: 'a', name: 'qwts-cursor-agent.2026-07-31.private-key.pem' },
  ]);
  assert.equal(chosen.id, 'a');
});

test('selectPrivateKeyAttachment rejects a sole non-.pem attachment', () => {
  assert.throws(
    () => selectPrivateKeyAttachment([{ id: 'a', name: 'notes.txt' }]),
    /no private-key.pem attachment/,
  );
});

test('ensurePrivateKey is a no-op when the key already exists', () => {
  const home = mkdtempSync(join(tmpdir(), 'ensure-key-'));
  const path = privateKeyPath('qwts-cursor-agent', home);
  mkdirSync(join(home, '.config', 'qwts-cursor-agent'), { recursive: true });
  writeFileSync(path, 'EXISTING\n');

  const calls = [];
  const result = ensurePrivateKey({
    slug: 'qwts-cursor-agent',
    home,
    run: (args) => {
      calls.push(args);
      return '';
    },
  });

  assert.equal(result.downloaded, false);
  assert.equal(result.path, path);
  assert.equal(calls.length, 0);
  assert.equal(readFileSync(path, 'utf8'), 'EXISTING\n');
});

test('parseCliArgs accepts positional slug, --app, and --force', () => {
  assert.deepEqual(parseCliArgs(['qwts-cursor-agent']), {
    force: false,
    explicit: 'qwts-cursor-agent',
  });
  assert.deepEqual(parseCliArgs(['--force', '--app', 'qwts-codex-agent']), {
    force: true,
    explicit: 'qwts-codex-agent',
  });
  assert.throws(() => parseCliArgs(['--app']), /--app requires a slug/);
  assert.throws(() => parseCliArgs(['--nope']), /unknown flag/);
});

test('ensurePrivateKey --force re-downloads over an existing key', () => {
  const home = mkdtempSync(join(tmpdir(), 'ensure-key-'));
  const path = privateKeyPath('qwts-cursor-agent', home);
  mkdirSync(join(home, '.config', 'qwts-cursor-agent'), { recursive: true });
  writeFileSync(path, 'STALE\n');

  const result = ensurePrivateKey({
    slug: 'qwts-cursor-agent',
    force: true,
    home,
    run: (args) => {
      if (args[1] === 'view') return JSON.stringify(SAMPLE_VIEW);
      writeFileSync(path, 'FRESH\n');
      return '';
    },
  });

  assert.equal(result.downloaded, true);
  assert.equal(readFileSync(path, 'utf8'), 'FRESH\n');
});

test('ensurePrivateKey views the agent item then downloads the pem attachment', () => {
  const home = mkdtempSync(join(tmpdir(), 'ensure-key-'));
  const path = privateKeyPath('qwts-cursor-agent', home);
  const calls = [];
  const result = ensurePrivateKey({
    slug: 'qwts-cursor-agent',
    home,
    exists: (p) => p !== path && existsSync(p),
    run: (args) => {
      calls.push(args);
      if (args[0] === 'item' && args[1] === 'view') {
        assert.deepEqual(args, [
          'item',
          'view',
          '--vault-name',
          AGENT_IDENTITIES_VAULT,
          '--item-title',
          'qwts-cursor-agent',
          '--output',
          'json',
        ]);
        return JSON.stringify(SAMPLE_VIEW);
      }
      if (args[0] === 'item' && args[1] === 'attachment') {
        assert.deepEqual(args, [
          'item',
          'attachment',
          'download',
          '--share-id',
          'share-xyz',
          '--item-id',
          'item-abc',
          '--attachment-id',
          'att-pem',
          '--output',
          path,
        ]);
        writeFileSync(path, '-----BEGIN RSA PRIVATE KEY-----\nTEST\n-----END RSA PRIVATE KEY-----\n');
        return '';
      }
      throw new Error(`unexpected pass-cli args: ${args.join(' ')}`);
    },
    chmod: chmodSync,
  });

  assert.equal(result.downloaded, true);
  assert.equal(result.path, path);
  assert.equal(calls.length, 2);
  assert.match(readFileSync(path, 'utf8'), /BEGIN RSA PRIVATE KEY/);
});
