// The Phase 1 deterministic checks (qwts/playbook-engineering#2).
//
// Every rule exists because it prevents a specific, nameable agent failure —
// the `prevents` field below is normative, not decoration. A rule that cannot
// name the failure it prevents does not belong here (the issue's own
// acceptance criterion), and "tidiness" is not a failure.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseDoc } from './markdown.mjs';
import { estimateTokens } from './tokens.mjs';
import { globToRegExp, matchesAny } from './glob.mjs';

export const RULES = [
  {
    id: 'link-resolution',
    summary: 'Every relative link resolves to an existing file (and anchor).',
    prevents:
      'An agent that follows a dead link either fails the task or fabricates the missing content and continues confidently.',
  },
  {
    id: 'orphan-doc',
    summary: 'Every doc is reachable from a configured index.',
    prevents:
      'A doc reachable from no index is invisible to link-following retrieval: the guidance exists but no agent ever loads it.',
  },
  {
    id: 'stale-path',
    summary: 'Code paths referenced in backticks exist in the repo.',
    prevents:
      'A doc pointing at a moved or deleted file sends the agent to search for something that is not there — burned context, then a guess.',
  },
  {
    id: 'heading-structure',
    summary: 'One H1 first, no skipped levels, bounded depth.',
    prevents:
      'Docs are chunked on headings for retrieval; skipped or inverted levels put content under the wrong parent, so a retrieved chunk carries the wrong context.',
  },
  {
    id: 'front-loaded-summary',
    summary: 'The point of the doc appears in the first N tokens.',
    prevents:
      'Context-limited reads truncate the tail; a doc whose point comes last contributes its preamble and loses its conclusion.',
  },
  {
    id: 'required-fields',
    summary: 'Machine-consumed fields (e.g. ADR Status) exist and parse.',
    prevents:
      'A gate that reads a field (e.g. "is this ADR Accepted?") silently passes or hard-fails when the field is missing or free-form.',
  },
  {
    id: 'token-budget',
    summary: 'Per-doc and per-context-set token budgets, ratcheting down.',
    prevents:
      'Unbudgeted docs grow until the context set no longer fits, and every session pays the overweight before doing any work.',
  },
  {
    id: 'positional-reference',
    summary: 'No "see above" / "as discussed below".',
    prevents:
      'A retrieved chunk has no above or below; the reference dangles and the agent guesses what it pointed at.',
  },
  {
    id: 'unresolved-placeholder',
    summary: 'No TODO/TBD/FIXME in normative text.',
    prevents:
      'An agent cannot tell a placeholder from a rule; it either follows "TBD" as instruction or stalls on it.',
  },
  {
    id: 'duplicate-statement',
    summary: 'No statement duplicated across docs.',
    prevents:
      'Two copies of one rule always eventually contradict, and the agent confidently follows whichever copy it retrieved — worse than no guidance.',
  },
  {
    id: 'terminology',
    summary: 'One name per concept (configured alias map).',
    prevents:
      'Aliases split retrieval: a search for the canonical term misses the doc that used the alias, so the agent concludes the topic is undocumented.',
  },
];

const DEFAULTS = {
  include: ['docs/**/*.md', 'README.md'],
  exclude: [],
  indexes: [],
  tokenBudgets: {
    perDoc: 10000,
    overrides: [],
    bankSlack: 0.25,
    contextSets: [],
  },
  structure: {
    maxHeadingDepth: 4,
    summaryWithinTokens: 250,
    requiredFields: [],
  },
  antiPatterns: {
    positionalReferences: true,
    unresolvedPlaceholders: true,
    duplicateParagraphs: { minLength: 160, allow: [] },
    terminology: [],
  },
  integrity: {
    links: true,
    orphans: true,
    stalePaths: { roots: null },
  },
};

export function resolveConfig(raw) {
  const merge = (base, over) => {
    if (over === undefined) return base;
    if (Array.isArray(base) || typeof base !== 'object' || base === null) return over;
    const out = { ...base };
    for (const key of Object.keys(over)) out[key] = merge(base[key], over[key]);
    return out;
  };
  return merge(DEFAULTS, raw);
}

// --- helpers -------------------------------------------------------------

function normalizeRel(p) {
  return p.split(path.sep).join('/');
}

class DocSet {
  constructor(root, includedPaths) {
    this.root = root;
    this.included = new Set(includedPaths);
    this.cache = new Map();
  }

  // Parses any repo markdown file on demand — context-set closures may pull
  // in files outside the include globs, and anchors must be checkable in any
  // link target that exists.
  get(rel) {
    if (this.cache.has(rel)) return this.cache.get(rel);
    const abs = path.join(this.root, rel);
    let doc = null;
    if (existsSync(abs) && statSync(abs).isFile()) {
      const source = readFileSync(abs, 'utf8');
      doc = { ...parseDoc(source), source, tokens: estimateTokens(source) };
    }
    this.cache.set(rel, doc);
    return doc;
  }
}

// Resolves a link target relative to the doc that contains it. Returns null
// for links this gate does not judge (external, mailto, absolute).
function resolveTarget(fromRel, target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null; // http:, mailto:, …
  if (target.startsWith('/')) return null; // site-absolute — not repo-relative
  const [filePart, anchor] = target.split('#');
  const rel =
    filePart === ''
      ? fromRel // pure #anchor → same file
      : normalizeRel(path.normalize(path.join(path.dirname(fromRel), filePart)));
  return { rel, anchor: anchor || null };
}

// --- checks --------------------------------------------------------------

function checkLinks(docs, docSet, findings) {
  for (const [rel, doc] of docs) {
    for (const link of doc.links) {
      const resolved = resolveTarget(rel, link.target);
      if (!resolved) continue;
      if (resolved.rel.startsWith('../')) {
        findings.push({
          rule: 'link-resolution',
          file: rel,
          line: link.line,
          message: `link "${link.target}" escapes the repository root`,
        });
        continue;
      }
      const abs = path.join(docSet.root, resolved.rel);
      if (!existsSync(abs)) {
        findings.push({
          rule: 'link-resolution',
          file: rel,
          line: link.line,
          message: `link "${link.target}" does not resolve (${resolved.rel} not found)`,
        });
        continue;
      }
      if (resolved.anchor && resolved.rel.endsWith('.md')) {
        const targetDoc = docSet.get(resolved.rel);
        if (
          targetDoc &&
          !targetDoc.headings.some((h) => h.slug === resolved.anchor) &&
          !targetDoc.htmlAnchors.has(resolved.anchor)
        ) {
          findings.push({
            rule: 'link-resolution',
            file: rel,
            line: link.line,
            message: `anchor "#${resolved.anchor}" not found in ${resolved.rel}`,
          });
        }
      }
    }
  }
}

function checkOrphans(docs, docSet, indexes, findings) {
  const reachable = new Set();
  const queue = [];
  for (const index of indexes) {
    if (!docs.has(index)) {
      findings.push({
        rule: 'orphan-doc',
        file: index,
        line: 1,
        message: `configured index "${index}" is not in the scanned doc set — fix "indexes" or "include"`,
      });
      continue;
    }
    reachable.add(index);
    queue.push(index);
  }
  while (queue.length > 0) {
    const rel = queue.pop();
    const doc = docs.get(rel);
    if (!doc) continue;
    for (const link of doc.links) {
      // An unused reference definition renders as nothing; only links a
      // reader (or link-following agent) can actually traverse confer
      // reachability.
      if (link.isDefinition) continue;
      const resolved = resolveTarget(rel, link.target);
      if (!resolved) continue;
      if (docs.has(resolved.rel) && !reachable.has(resolved.rel)) {
        reachable.add(resolved.rel);
        queue.push(resolved.rel);
      }
    }
  }
  for (const rel of docs.keys()) {
    if (!reachable.has(rel)) {
      findings.push({
        rule: 'orphan-doc',
        file: rel,
        line: 1,
        message: 'reachable from no configured index — link it from one, or exclude it deliberately',
      });
    }
  }
}

// Only spans that unambiguously look like repo paths are judged: at least one
// slash, path-safe characters, no glob/placeholder syntax, and a first
// segment that names a real top-level entry (or a configured root). Anything
// less certain is skipped — a false positive here would teach people to
// ignore the gate.
function checkStalePaths(docs, docSet, rootsConfig, findings) {
  const topLevel = new Set(rootsConfig ?? readdirNames(docSet.root));
  const pathLike = /^\.?\/?[\w@.-]+(\/[\w@.-]+)+$/;
  for (const [rel, doc] of docs) {
    doc.codeSpans.forEach((spans, lineIndex) => {
      for (const span of spans) {
        let candidate = span.text.trim();
        candidate = candidate.replace(/:\d+(?:-\d+)?$/, ''); // strip :line refs
        if (!pathLike.test(candidate)) continue;
        if (/[*?{}<>]|\.{3}|NNNN|nnnn|XXXX/.test(candidate)) continue; // template/example paths
        const cleaned = candidate.replace(/^\.?\//, '');
        if (!topLevel.has(cleaned.split('/')[0])) continue; // not rooted in this repo
        const absFromRoot = path.join(docSet.root, cleaned);
        const absFromDoc = path.join(docSet.root, path.dirname(rel), cleaned);
        if (!existsSync(absFromRoot) && !existsSync(absFromDoc)) {
          findings.push({
            rule: 'stale-path',
            file: rel,
            line: lineIndex + 1,
            message: `\`${span.text.trim()}\` does not exist — the code moved and this doc did not`,
          });
        }
      }
    });
  }
}

function readdirNames(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function checkHeadings(docs, maxDepth, findings) {
  for (const [rel, doc] of docs) {
    const { headings } = doc;
    if (headings.length === 0) continue;
    if (headings[0].level !== 1) {
      findings.push({
        rule: 'heading-structure',
        file: rel,
        line: headings[0].line,
        message: `first heading is H${headings[0].level}; chunkers treat the first heading as the document title`,
      });
    }
    headings
      .filter((h, i) => h.level === 1 && i > 0)
      .forEach((h) => {
        findings.push({
          rule: 'heading-structure',
          file: rel,
          line: h.line,
          message: 'second H1 — a chunk from the second half inherits the wrong title',
        });
      });
    for (let i = 1; i < headings.length; i++) {
      if (headings[i].level > headings[i - 1].level + 1) {
        findings.push({
          rule: 'heading-structure',
          file: rel,
          line: headings[i].line,
          message: `H${headings[i].level} under H${headings[i - 1].level} skips a level — the chunk hierarchy misparents this section`,
        });
      }
    }
    for (const h of headings) {
      if (h.level > maxDepth) {
        findings.push({
          rule: 'heading-structure',
          file: rel,
          line: h.line,
          message: `H${h.level} exceeds max depth ${maxDepth} — nesting this deep loses its ancestry when chunked`,
        });
      }
    }
  }
}

function checkSummary(docs, withinTokens, findings) {
  for (const [rel, doc] of docs) {
    // Byte prefix corresponding to the token allowance (same estimator as
    // budgets), converted to a line horizon.
    const byteLimit = withinTokens * 4;
    let bytes = 0;
    let lineHorizon = 0;
    for (const line of doc.lines) {
      bytes += Buffer.byteLength(line, 'utf8') + 1;
      lineHorizon += 1;
      if (bytes > byteLimit) break;
    }
    // Blockquotes count: a lead `> Canonical reference for …` blockquote is a
    // summary in every repo that uses the convention.
    const hasEarlyProse = doc.blocks.some(
      (b) =>
        (b.kind === 'paragraph' || b.kind === 'blockquote') &&
        b.startLine <= lineHorizon &&
        b.normalized.length > 0,
    );
    if (!hasEarlyProse) {
      findings.push({
        rule: 'front-loaded-summary',
        file: rel,
        line: 1,
        message: `no prose within the first ~${withinTokens} tokens — truncated reads get structure but never the point`,
      });
    }
  }
}

function checkRequiredFields(docs, specs, findings) {
  for (const spec of specs) {
    const re = globToRegExp(spec.glob);
    for (const [rel, doc] of docs) {
      if (!re.test(rel)) continue;
      // Optional per-spec exclusion globs: the glob language has no negation,
      // so a field rule that applies to "all but a grandfathered subset"
      // (e.g. ENG-0013 scoping its escape value to ENG-0001..0010) needs an
      // explicit carve-out rather than a wider pattern every file could use.
      if (spec.exclude && matchesAny(rel, spec.exclude)) continue;
      const head = doc.lines.slice(0, spec.searchLines ?? 30);
      for (const field of spec.fields) {
        const name = typeof field === 'string' ? field : field.name;
        const pattern = typeof field === 'string' ? null : field.pattern;
        // Two accepted shapes: a `Field: value` line, or a `## Field` heading
        // whose first non-blank line is the value (the photos ADR format).
        let value = null;
        for (const line of head) {
          const plain = line.replace(/[*_]/g, '');
          const m = plain.match(new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`));
          if (m) {
            value = m[1].trim();
            break;
          }
        }
        if (value === null) {
          const heading = doc.headings.find(
            (h) => h.text.toLowerCase() === name.toLowerCase() && h.line <= head.length,
          );
          if (heading) {
            const next = doc.lines
              .slice(heading.line)
              .find((line) => line.trim() !== '' && !/^#{1,6}\s/.test(line));
            if (next) value = next.replace(/[*_]/g, '').trim();
          }
        }
        if (value === null || value === '') {
          findings.push({
            rule: 'required-fields',
            file: rel,
            line: 1,
            message: `missing "${name}:" — machine consumers of ${spec.glob} read this field`,
          });
        } else if (pattern && !new RegExp(pattern).test(value)) {
          findings.push({
            rule: 'required-fields',
            file: rel,
            line: 1,
            message: `"${name}: ${value}" does not match required pattern /${pattern}/`,
          });
        }
      }
    }
  }
}

function checkTokenBudgets(docs, docSet, budgets, findings) {
  const overridesByPath = new Map(budgets.overrides.map((o) => [o.path, o]));

  for (const override of budgets.overrides) {
    if (!docs.has(override.path)) {
      findings.push({
        rule: 'token-budget',
        file: override.path,
        line: 1,
        message: 'budget override points at a doc that is not scanned — delete the entry or fix the path',
      });
    }
    if (override.budget > budgets.perDoc && !override.reason) {
      findings.push({
        rule: 'token-budget',
        file: override.path,
        line: 1,
        message: `override raises the budget above the default (${budgets.perDoc}) with no recorded reason — budgets never go up silently`,
      });
    }
  }

  for (const [rel, doc] of docs) {
    const override = overridesByPath.get(rel);
    const budget = override?.budget ?? budgets.perDoc;
    if (doc.tokens > budget) {
      findings.push({
        rule: 'token-budget',
        file: rel,
        line: 1,
        message: `~${doc.tokens} tokens exceeds budget ${budget} — split, tighten, or raise the budget with a reason`,
      });
    } else if (override && doc.tokens < budget * (1 - budgets.bankSlack)) {
      findings.push({
        rule: 'token-budget',
        file: rel,
        line: 1,
        message: `~${doc.tokens} tokens is well under override ${budget} — lower the override to bank the win`,
      });
    }
  }

  for (const set of budgets.contextSets) {
    const closure = new Set();
    const queue = [];
    let missing = false;
    for (const entry of set.entrypoints) {
      if (!docSet.get(entry)) {
        findings.push({
          rule: 'token-budget',
          file: entry,
          line: 1,
          message: `context set "${set.name}" entrypoint does not exist`,
        });
        missing = true;
        continue;
      }
      closure.add(entry);
      queue.push(entry);
    }
    if (missing) continue;
    while (queue.length > 0) {
      const rel = queue.pop();
      const doc = docSet.get(rel);
      if (!doc) continue;
      for (const link of doc.links) {
        if (link.isDefinition) continue; // an unused def pulls nothing into context
        const resolved = resolveTarget(rel, link.target);
        if (!resolved || !resolved.rel.endsWith('.md')) continue;
        if (!closure.has(resolved.rel) && docSet.get(resolved.rel)) {
          closure.add(resolved.rel);
          queue.push(resolved.rel);
        }
      }
    }
    const total = [...closure].reduce((sum, rel) => sum + docSet.get(rel).tokens, 0);
    if (total > set.budget) {
      findings.push({
        rule: 'token-budget',
        file: set.entrypoints[0],
        line: 1,
        message:
          `context set "${set.name}" is ~${total} tokens across ${closure.size} files, over budget ${set.budget} — ` +
          'this is what a session pays before doing any work',
      });
    } else if (total < set.budget * (1 - budgets.bankSlack)) {
      findings.push({
        rule: 'token-budget',
        file: set.entrypoints[0],
        line: 1,
        message: `context set "${set.name}" is ~${total} tokens, well under budget ${set.budget} — lower the budget to bank the win`,
      });
    }
  }
}

const POSITIONAL = [
  /\b(?:see|discussed|mentioned|described|noted|shown|listed|outlined|explained)\s+(?:above|below|earlier|previously)\b/i,
  /\bas\s+(?:above|below)\b/i,
  /\bthe\s+(?:above|below)\s+(?:section|table|list|example|diagram|steps?|rules?)\b/i,
];

function checkPositional(docs, findings) {
  for (const [rel, doc] of docs) {
    doc.masked.forEach((line, i) => {
      for (const re of POSITIONAL) {
        const m = line.match(re);
        if (m) {
          findings.push({
            rule: 'positional-reference',
            file: rel,
            line: i + 1,
            message: `"${m[0]}" — a retrieved chunk has no above or below; link the target instead`,
          });
          break;
        }
      }
    });
  }
}

function checkPlaceholders(docs, findings) {
  const re = /\b(TODO|TBD|FIXME|TKTK|XXX)\b/;
  for (const [rel, doc] of docs) {
    doc.masked.forEach((line, i) => {
      const m = line.match(re);
      if (m) {
        findings.push({
          rule: 'unresolved-placeholder',
          file: rel,
          line: i + 1,
          message: `"${m[1]}" in normative text — an agent cannot tell a placeholder from a rule`,
        });
      }
    });
  }
}

function checkDuplicates(docs, dupConfig, findings) {
  const seen = new Map(); // normalized text → [{file, line}]
  for (const [rel, doc] of docs) {
    for (const block of doc.blocks) {
      if (block.normalized.length < dupConfig.minLength) continue;
      if (dupConfig.allow.some((allowed) => block.normalized.includes(allowed.toLowerCase()))) continue;
      const list = seen.get(block.normalized) ?? [];
      list.push({ file: rel, line: block.startLine });
      seen.set(block.normalized, list);
    }
  }
  for (const [text, locations] of seen) {
    if (locations.length < 2) continue;
    const where = locations.map((l) => `${l.file}:${l.line}`).join(', ');
    findings.push({
      rule: 'duplicate-statement',
      file: locations[0].file,
      line: locations[0].line,
      message: `stated ${locations.length}× (${where}): "${text.slice(0, 80)}…" — keep one copy and link to it`,
    });
  }
}

function checkTerminology(docs, terms, findings) {
  for (const term of terms) {
    const patterns = term.aliases.map(
      (alias) => new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
    );
    for (const [rel, doc] of docs) {
      doc.masked.forEach((line, i) => {
        for (const re of patterns) {
          const m = line.match(re);
          if (m) {
            findings.push({
              rule: 'terminology',
              file: rel,
              line: i + 1,
              message: `"${m[0]}" — the canonical name is "${term.canonical}"; aliases split retrieval`,
            });
          }
        }
      });
    }
  }
}

// --- entry ---------------------------------------------------------------

export function runChecks(root, includedFiles, config) {
  const docSet = new DocSet(root, includedFiles);
  const docs = new Map();
  for (const rel of includedFiles) {
    const doc = docSet.get(rel);
    if (doc) docs.set(rel, doc);
  }

  const findings = [];
  if (config.integrity.links) checkLinks(docs, docSet, findings);
  if (config.integrity.orphans && config.indexes.length > 0) {
    checkOrphans(docs, docSet, config.indexes, findings);
  }
  checkStalePaths(docs, docSet, config.integrity.stalePaths.roots, findings);
  checkHeadings(docs, config.structure.maxHeadingDepth, findings);
  checkSummary(docs, config.structure.summaryWithinTokens, findings);
  checkRequiredFields(docs, config.structure.requiredFields, findings);
  checkTokenBudgets(docs, docSet, config.tokenBudgets, findings);
  if (config.antiPatterns.positionalReferences) checkPositional(docs, findings);
  if (config.antiPatterns.unresolvedPlaceholders) checkPlaceholders(docs, findings);
  checkDuplicates(docs, config.antiPatterns.duplicateParagraphs, findings);
  checkTerminology(docs, config.antiPatterns.terminology, findings);

  findings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule),
  );
  return { findings, stats: { docCount: docs.size, totalTokens: [...docs.values()].reduce((s, d) => s + d.tokens, 0) } };
}
