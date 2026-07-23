// Tool-config detection.
//
// The presence of a config file (`.markdownlint.json`, `deny.toml`,
// `tsconfig.json`, …) is a cheap, direct signal of which tools a repo runs —
// the "what should a new project adopt" question ENG-0011 wants answered
// without inferring anything from package graphs. Patterns are config-driven so
// each repo declares what counts; we only report which of them exist.

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { matchesAny } from './glob.mjs';

// Walk the repo and return the repo-relative paths of files matching any
// configured tool-config glob. Directories that never hold config (VCS,
// dependencies, this tooling's own checkout) are skipped for speed.
export function collectToolConfigs(root, globs = []) {
  const out = [];
  if (globs.length === 0 || !existsSync(root)) return out;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (
        rel.startsWith('.git/') ||
        rel.includes('node_modules/') ||
        rel.startsWith('.dep-inventory/')
      ) {
        continue;
      }
      if (statSync(abs).isDirectory()) walk(abs);
      else if (matchesAny(rel, globs)) out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}
