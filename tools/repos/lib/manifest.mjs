// Governed-repos manifest — load, validate, and render (ENG-0011).
//
// The manifest (governance/repos.json) is the single source of truth for the
// set of repositories this playbook governs. This module keeps the schema, the
// validation rules, and the markdown-table renderer in one place so the CLI and
// its tests share exactly one definition. Zero dependencies by design, matching
// tools/docs-gov: the JSON parses with the stdlib and the table is rendered by
// hand, so a bare checkout can run the check with no install.

import { readFileSync } from 'node:fs';
import {
  GOVERNED_HARNESS_FILES,
  GOVERNED_HOOK_ADAPTER_FILES,
  RETIRED_HARNESS_FILES,
} from './baseline-files.mjs';

export const VALID_VISIBILITY = ['public', 'private'];
export const VALID_STATUS = ['active', 'onboarding', 'retired'];

// The markers that fence the generated table inside the governed doc. Prose
// lives outside them; everything between is owned by the generator.
export const BEGIN_MARKER = '<!-- BEGIN GENERATED governed-repos -->';
export const END_MARKER = '<!-- END GENERATED governed-repos -->';

export function loadManifest(manifestPath) {
  let raw;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch {
    throw new Error(`manifest not found: ${manifestPath}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`manifest is not valid JSON (${manifestPath}): ${error.message}`);
  }
}

// Returns an array of human-readable problem strings; empty means valid. The
// caller decides how to report — the validator never prints or exits.
export function validateManifest(manifest) {
  const errors = [];
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['manifest must be a JSON object'];
  }
  if (typeof manifest.account !== 'string' || manifest.account.trim() === '') {
    errors.push('`account` must be a non-empty string');
  }
  if (!Array.isArray(manifest.repos)) {
    errors.push('`repos` must be an array');
    return errors;
  }

  const seen = new Set();
  manifest.repos.forEach((repo, i) => {
    const where = `repos[${i}]`;
    if (repo === null || typeof repo !== 'object' || Array.isArray(repo)) {
      errors.push(`${where} must be an object`);
      return;
    }
    const name = repo.name;
    if (typeof name !== 'string' || name.trim() === '') {
      errors.push(`${where}.name must be a non-empty string`);
    } else if (!/^[\w.-]+$/.test(name)) {
      // GitHub repo slugs: word chars, dots, hyphens. Anything else (spaces,
      // trailing whitespace, slashes) is a typo that would also dodge the
      // duplicate check, so reject it outright.
      errors.push(`${where}.name "${name}" is not a valid repo slug ([\\w.-]+ only)`);
    } else {
      const key = name.toLowerCase();
      if (seen.has(key)) errors.push(`${where}.name "${name}" is a duplicate`);
      seen.add(key);
    }
    if (!VALID_VISIBILITY.includes(repo.visibility)) {
      errors.push(`${where}.visibility must be one of ${VALID_VISIBILITY.join(', ')} (got ${JSON.stringify(repo.visibility)})`);
    }
    if (!VALID_STATUS.includes(repo.status)) {
      errors.push(`${where}.status must be one of ${VALID_STATUS.join(', ')} (got ${JSON.stringify(repo.status)})`);
    }
    if (typeof repo.sharedCi !== 'boolean') {
      errors.push(`${where}.sharedCi must be a boolean`);
    }
    // Consumed by the public dashboard as an opt-in publication gate: only the
    // boolean `true` publishes a repo. A string "true" or a 1 would be treated
    // as not-opted-in and the repo would vanish from the dashboard silently, so
    // the typo is caught here rather than becoming an invisible omission
    // downstream. Absent means do not publish, which is the intended default.
    if (repo.publish !== undefined && typeof repo.publish !== 'boolean') {
      errors.push(`${where}.publish must be a boolean when present`);
    }
    if (repo.delta !== undefined && typeof repo.delta !== 'string') {
      errors.push(`${where}.delta must be a string when present`);
    }
    if (repo.note !== undefined && typeof repo.note !== 'string') {
      errors.push(`${where}.note must be a string when present`);
    }
    if (repo.codexSync !== undefined) {
      if (repo.codexSync === null || typeof repo.codexSync !== 'object' || Array.isArray(repo.codexSync)) {
        errors.push(`${where}.codexSync must be an object when present`);
      } else {
        if (repo.codexSync.enabled !== undefined && typeof repo.codexSync.enabled !== 'boolean') {
          errors.push(`${where}.codexSync.enabled must be a boolean when present`);
        }
        if (repo.codexSync.exclude !== undefined) {
          if (!Array.isArray(repo.codexSync.exclude)) {
            errors.push(`${where}.codexSync.exclude must be an array when present`);
          } else {
            const excluded = new Set();
            for (const path of repo.codexSync.exclude) {
              // A retired path is a valid exclusion: it opts the repo out of
              // retraction, keeping its copy as repo-owned (#287).
              if (!GOVERNED_HARNESS_FILES.includes(path) && !RETIRED_HARNESS_FILES.includes(path)) {
                errors.push(`${where}.codexSync.exclude contains unmanaged path ${JSON.stringify(path)}`);
              } else if (excluded.has(path)) {
                errors.push(`${where}.codexSync.exclude contains duplicate path ${JSON.stringify(path)}`);
              }
              excluded.add(path);
            }
          }
        }
        if (repo.codexSync.preserveJsonArrayEntries !== undefined) {
          const compositions = repo.codexSync.preserveJsonArrayEntries;
          if (compositions === null || typeof compositions !== 'object' || Array.isArray(compositions)) {
            errors.push(`${where}.codexSync.preserveJsonArrayEntries must be an object when present`);
          } else {
            const excluded = new Set(
              Array.isArray(repo.codexSync.exclude) ? repo.codexSync.exclude : [],
            );
            for (const [path, markers] of Object.entries(compositions)) {
              if (!GOVERNED_HOOK_ADAPTER_FILES.includes(path) || !path.endsWith('.json')) {
                errors.push(
                  `${where}.codexSync.preserveJsonArrayEntries contains unmanaged JSON path ${JSON.stringify(path)}`,
                );
              }
              if (excluded.has(path)) {
                errors.push(
                  `${where}.codexSync.preserveJsonArrayEntries configures excluded path ${JSON.stringify(path)}`,
                );
              }
              if (!Array.isArray(markers) || markers.length === 0) {
                errors.push(
                  `${where}.codexSync.preserveJsonArrayEntries.${path} must be a non-empty array`,
                );
                continue;
              }
              const seenMarkers = new Set();
              for (const marker of markers) {
                if (typeof marker !== 'string' || marker.length === 0) {
                  errors.push(
                    `${where}.codexSync.preserveJsonArrayEntries.${path} contains an invalid marker`,
                  );
                } else if (seenMarkers.has(marker)) {
                  errors.push(
                    `${where}.codexSync.preserveJsonArrayEntries.${path} contains duplicate marker ${JSON.stringify(marker)}`,
                  );
                }
                seenMarkers.add(marker);
              }
            }
          }
        }
      }
    }
  });
  return errors;
}

function escapeCell(text) {
  // Table cells cannot contain a raw pipe or newline; collapse whitespace and
  // escape pipes so a multi-clause delta stays on one row. Backslashes are
  // escaped first so a value containing `\|` cannot smuggle an unescaped pipe
  // through (CodeQL js/incomplete-sanitization).
  return String(text ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .trim();
}

// Renders just the markdown table, in manifest order (deterministic — the
// drift check depends on identical output for identical input).
export function renderTable(manifest) {
  const header =
    '| Repo | Visibility | Status | Shared CI | Codex sync | Delta from baseline |\n' +
    '| --- | --- | --- | --- | --- | --- |';
  const rows = manifest.repos.map((repo) => {
    const delta = escapeCell(repo.delta) || '—';
    const sharedCi = repo.sharedCi ? 'yes' : 'no';
    const excluded = repo.codexSync?.exclude ?? [];
    const codexSync = repo.codexSync?.enabled === false
      ? 'disabled'
      : excluded.length
        ? `managed except ${excluded.map((path) => `\`${escapeCell(path)}\``).join(', ')}`
        : 'managed';
    return `| \`${escapeCell(repo.name)}\` | ${repo.visibility} | ${repo.status} | ${sharedCi} | ${codexSync} | ${delta} |`;
  });
  return [header, ...rows].join('\n');
}

// The full fenced block, markers included, that the generator owns.
export function renderBlock(manifest) {
  return [
    BEGIN_MARKER,
    '<!-- Generated from governance/repos.json by tools/repos/repos.mjs. Do not edit by hand. -->',
    '',
    '*Generated table — to change it, edit `governance/repos.json` and run `node tools/repos/repos.mjs --write`.*',
    '',
    renderTable(manifest),
    END_MARKER,
  ].join('\n');
}

// Pulls the current generated block out of a doc, or null if the markers are
// absent. Used by the drift check to compare against a fresh render.
export function extractBlock(docSource) {
  const start = docSource.indexOf(BEGIN_MARKER);
  const end = docSource.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) return null;
  return docSource.slice(start, end + END_MARKER.length);
}

// Replaces the generated block in a doc with freshly-rendered content. Throws
// if the markers are missing so `--write` fails loudly rather than appending.
export function spliceBlock(docSource, manifest) {
  const start = docSource.indexOf(BEGIN_MARKER);
  const end = docSource.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`generated-block markers not found in doc (${BEGIN_MARKER} … ${END_MARKER})`);
  }
  return docSource.slice(0, start) + renderBlock(manifest) + docSource.slice(end + END_MARKER.length);
}
