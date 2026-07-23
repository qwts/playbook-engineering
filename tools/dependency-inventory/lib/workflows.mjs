// GitHub Actions inventory from workflow YAML.
//
// `uses:` lines are extracted by line regex rather than a YAML parse: the value
// is always a single token, and a YAML library would break the zero-install
// property the reusable workflow depends on. This is the same surface pinact
// and zizmor read, so the pin-status it reports lines up with the ENG-0005
// SHA-pinning direction — every unpinned action is visible in the inventory.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { matchesAny } from './glob.mjs';

const USES = /^\s*(?:-\s*)?uses:\s*(['"]?)([^'"\s#]+)\1/;
const SHA = /^[0-9a-f]{40}$/;

// Split `owner/repo/path@ref` into the action reference and its ref. A local
// `./path` or `docker://…` use has no `@ref` and reports a null ref.
function splitUses(value) {
  const at = value.lastIndexOf('@');
  if (value.startsWith('./') || value.startsWith('.\\') || at === -1) {
    return { uses: value, ref: null };
  }
  return { uses: value.slice(0, at), ref: value.slice(at + 1) };
}

// All workflow files matching the configured globs, walked from root.
function workflowFiles(root, globs) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (rel.startsWith('.git/') || rel.includes('node_modules/')) continue;
      if (statSync(abs).isDirectory()) walk(abs);
      else if (matchesAny(rel, globs)) out.push(rel);
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

// Return one row per (action, ref) seen, with pin status and the files it
// appears in. `pinnedSha` is the 40-hex ref when the action is SHA-pinned,
// else null — a null on a third-party `owner/repo` action is the finding
// ENG-0005 cares about.
export function collectActions(root, globs = []) {
  const seen = new Map(); // key: `${uses}@${ref}` → row
  for (const rel of workflowFiles(root, globs)) {
    const lines = readFileSync(path.join(root, rel), 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = USES.exec(line);
      if (!m) continue;
      const { uses, ref } = splitUses(m[2]);
      const key = `${uses}@${ref ?? ''}`;
      const row =
        seen.get(key) ??
        { uses, ref, pinnedSha: ref && SHA.test(ref) ? ref : null, files: [] };
      if (!row.files.includes(rel)) row.files.push(rel);
      seen.set(key, row);
    }
  }
  return [...seen.values()].sort(
    (a, b) => a.uses.localeCompare(b.uses) || String(a.ref).localeCompare(String(b.ref)),
  );
}
