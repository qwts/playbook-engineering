// Minimal markdown scanner — extracts exactly the structure the checks need
// (headings, links, code spans, prose blocks) and nothing else. Not a
// spec-complete parser on purpose: the checks must be deterministic and
// zero-dependency so every consumer repo can run them from a bare checkout.

// GitHub's heading-anchor algorithm, close enough for gate purposes:
// lowercase, strip markdown formatting, drop everything that is not a
// letter/number/space/hyphen/underscore (this removes emoji and punctuation
// but keeps their surrounding spaces), then spaces become hyphens. No trim —
// GitHub keeps the leading hyphen that a stripped leading emoji produces.
export function slugify(headingText) {
  return headingText
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[`*~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '')
    .replace(/ /g, '-');
}

// Masks fenced code blocks and inline code spans with spaces (preserving
// line numbers and offsets) so content checks never fire on code examples —
// a doc that *documents* the TODO rule must be able to write `TODO` in a
// code span without tripping the gate it describes.
function maskCode(lines) {
  const masked = [];
  const codeSpanRanges = []; // per line: [{start, end}] for inline spans
  let inFence = false;
  let fenceMarker = '';
  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch && !inFence) {
      inFence = true;
      fenceMarker = fenceMatch[1][0];
      masked.push('');
      codeSpanRanges.push([]);
      continue;
    }
    if (fenceMatch && inFence && fenceMatch[1][0] === fenceMarker) {
      inFence = false;
      masked.push('');
      codeSpanRanges.push([]);
      continue;
    }
    if (inFence) {
      masked.push('');
      codeSpanRanges.push([]);
      continue;
    }
    // Mask inline code spans but remember their contents for the stale-path
    // check, which reads *only* code spans.
    const spans = [];
    const maskedLine = line.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (match, ticks, body, offset) => {
      spans.push({ text: body, column: 0 });
      return ' '.repeat(match.length);
    });
    masked.push(maskedLine);
    codeSpanRanges.push(spans);
  }
  return { masked, codeSpans: codeSpanRanges };
}

// A parsed document. All line numbers are 1-based.
export function parseDoc(source) {
  const lines = source.split('\n');
  const { masked, codeSpans } = maskCode(lines);

  const headings = [];
  const slugCounts = new Map();
  for (let i = 0; i < masked.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (!m || masked[i] === '') continue; // '' means the line sat in a fence
    let slug = slugify(m[2]);
    const seen = slugCounts.get(slug) ?? 0;
    slugCounts.set(slug, seen + 1);
    if (seen > 0) slug = `${slug}-${seen}`;
    headings.push({ level: m[1].length, text: m[2], line: i + 1, slug });
  }

  // Inline links and images on code-masked text, plus reference definitions.
  const links = [];
  const linkPattern = /!?\[([^\]]*)\]\(([^()\s]+(?:\([^()\s]*\)[^()\s]*)?)(?:\s+"[^"]*")?\)/g;
  const refDefPattern = /^\s*\[([^\]]+)\]:\s+(\S+)/;
  for (let i = 0; i < masked.length; i++) {
    for (const m of masked[i].matchAll(linkPattern)) {
      links.push({ text: m[1], target: m[2], line: i + 1 });
    }
    const def = masked[i].match(refDefPattern);
    if (def) links.push({ text: def[1], target: def[2], line: i + 1 });
  }

  // Prose blocks: maximal runs of non-blank, non-heading masked lines. Each
  // block records whether it is "prose" (not a list item / table / blockquote
  // start) for the front-loaded-summary check, and a normalized form for the
  // duplicate-statement check. List items are split into their own blocks —
  // normative rules usually live one per bullet, and duplicate detection
  // needs to match them individually.
  const blocks = [];
  let current = null;
  const flush = () => {
    if (current) blocks.push(current);
    current = null;
  };
  for (let i = 0; i < masked.length; i++) {
    const line = masked[i];
    const raw = lines[i];
    const isHeading = /^#{1,6}\s/.test(raw) && line !== '';
    if (line.trim() === '' || isHeading) {
      flush();
      continue;
    }
    const listItem = /^\s*(?:[-*+]|\d+[.)])\s+/.test(line);
    if (listItem) {
      flush();
      current = { startLine: i + 1, lines: [line], kind: 'list-item' };
      continue;
    }
    if (!current) {
      // Blockquotes are tracked apart from tables: a lead blockquote is a
      // legitimate summary, a lead table is not.
      const kind = /^\s*\|/.test(line) ? 'other' : /^\s*>/.test(line) ? 'blockquote' : 'paragraph';
      current = { startLine: i + 1, lines: [line], kind };
    } else {
      current.lines.push(line);
    }
  }
  flush();

  for (const block of blocks) {
    block.text = block.lines.join(' ');
    block.normalized = block.text
      .toLowerCase()
      .replace(/^[\s>*+-]+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/[`*_~]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Explicit HTML anchors (`<a id="…">`, or an id on any tag) are valid link
  // targets alongside heading slugs.
  const htmlAnchors = new Set();
  for (const line of masked) {
    for (const m of line.matchAll(/<[^>]*\b(?:id|name)="([^"]+)"[^>]*>/g)) {
      htmlAnchors.add(m[1]);
    }
  }

  return { lines, masked, codeSpans, headings, links, blocks, htmlAnchors };
}
