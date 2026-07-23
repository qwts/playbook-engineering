// Direct dev-tooling detection from manifests.
//
// The SBOM lists every package with its license, but does not reliably say
// which are *tooling* (linters, formatters, test runners, build tools) versus
// runtime. That distinction is the reuse signal ENG-0011 wants, so we take it
// from the one place it is authoritative: a repo's directly-declared dev
// dependencies. Transitive packages stay `runtime` by default — the reuse
// question is "what tools does this repo choose", which is a direct-dep fact.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// npm: devDependencies keys are the direct dev tools (eslint, prettier, vitest…).
function npmDevNames(manifestPath) {
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return Object.keys(pkg.devDependencies ?? {});
}

// cargo: [dev-dependencies] and [build-dependencies] tables. A minimal TOML
// table reader — we only need the keys of two named tables, so a full TOML
// parser (and the dependency it would add) is not worth it. Reads keys until
// the next `[table]` header; ignores inline tables and comments.
function cargoDevNames(manifestPath) {
  const lines = readFileSync(manifestPath, 'utf8').split(/\r?\n/);
  const names = [];
  let inTable = false;
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      const table = header[1].trim();
      inTable = table === 'dev-dependencies' || table === 'build-dependencies';
      continue;
    }
    if (!inTable) continue;
    const key = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
    if (key) names.push(key[1]);
  }
  return names;
}

// Build the set of direct dev-tooling package names across every manifest named
// in config. Unreadable manifests are skipped (a repo need not have all of them).
export function devToolingNames(root, manifests = {}) {
  const names = new Set();
  const collect = (rel, reader) => {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) return;
    try {
      for (const name of reader(abs)) names.add(name);
    } catch {
      // A malformed manifest should not sink the whole inventory; it simply
      // contributes no dev-tooling classification.
    }
  };
  for (const rel of manifests.npm ?? []) collect(rel, npmDevNames);
  for (const rel of manifests.cargo ?? []) collect(rel, cargoDevNames);
  return names;
}
