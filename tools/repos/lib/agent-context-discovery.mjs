// The status-aware discovery contract for governed agent contexts. The prose
// has one source: the marked section in governance/baseline/AGENTS.md. Keeping
// the marker parser here means drift detection and reconciliation consume that
// source rather than maintaining a second semantic copy.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DISCOVERY_CHECK = 'shared agent-context discovery';
export const DISCOVERY_START = '<!-- governed:shared-agent-discovery:start -->';
export const DISCOVERY_END = '<!-- governed:shared-agent-discovery:end -->';

export function extractDiscoveryBlock(source) {
  const start = source.indexOf(DISCOVERY_START);
  const end = source.indexOf(DISCOVERY_END, start + DISCOVERY_START.length);
  if (start === -1 || end === -1) return null;
  return source.slice(start, end + DISCOVERY_END.length).trim();
}

export function loadCanonicalDiscoveryBlock(root) {
  const source = readFileSync(join(root, 'governance', 'baseline', 'AGENTS.md'), 'utf8');
  const block = extractDiscoveryBlock(source);
  if (!block) throw new Error('governance/baseline/AGENTS.md is missing the shared-agent-discovery markers');
  return block;
}

export function hasCanonicalDiscoveryBlock(source, canonicalBlock) {
  const starts = source.split(DISCOVERY_START).length - 1;
  const ends = source.split(DISCOVERY_END).length - 1;
  return starts === 1 && ends === 1 && extractDiscoveryBlock(source) === canonicalBlock;
}

// Active repositories fail closed; onboarding repositories retain a visible
// migration state but cannot graduate until the same block is conformant.
export function discoveryDisposition(status, source, canonicalBlock) {
  const conformant = hasCanonicalDiscoveryBlock(source, canonicalBlock);
  if (conformant) return { conformant: true, state: 'conformant', blocksPromotion: false };
  return {
    conformant: false,
    state: status === 'onboarding' ? 'migration' : 'drift',
    blocksPromotion: true,
  };
}

function replaceMarkedBlock(source, block) {
  const marked = new RegExp(`${DISCOVERY_START}[\\s\\S]*?${DISCOVERY_END}`, 'g');
  let count = 0;
  const replaced = source.replace(marked, () => {
    count += 1;
    return count === 1 ? block : '';
  });
  return count === 0 ? null : replaced;
}

// Older governed contexts used the same heading without markers. Replacing the
// complete heading section preserves all following repo-specific sections while
// preventing a second copy of the shared guidance from accumulating.
function replaceLegacySection(source, block) {
  const legacy = /^## Shared agent conventions(?: and skills)?\s*\n[\s\S]*?(?=^##\s|$(?![\s\S]))/m;
  return legacy.test(source) ? source.replace(legacy, `${block}\n\n`) : null;
}

export function projectDiscoveryBlock(source, canonicalBlock) {
  // A repository whose context is being reconciled is already being touched;
  // retain the playbook link target but retire its old branch name. Never
  // rewrite a repository-owned link: another project may still use master.
  const current = source.replaceAll(
    'https://github.com/qwts/playbook-engineering/blob/master/',
    'https://github.com/qwts/playbook-engineering/blob/main/',
  );
  const marked = replaceMarkedBlock(current, canonicalBlock);
  if (marked !== null) return marked;

  const legacy = replaceLegacySection(current, canonicalBlock);
  if (legacy !== null) return legacy;

  return `${current.trimEnd()}\n\n${canonicalBlock}\n`;
}
