// Fleet aggregation: many per-repo inventories → one cross-repo catalog.
//
// This is the "avoid recreating the wheel" surface — it answers, across the
// governed fleet, which tools are already in use, under which licenses, and
// which GitHub Actions are still unpinned. Output is a JSON record plus a
// human-readable Markdown rendering; both are artifacts, never a governed doc
// (a fleet-sized table would blow the docs-gov token budget).

function pushUnique(arr, value) {
  if (!arr.includes(value)) arr.push(value);
}

export function buildCatalog(inventories, { generatedAt = null } = {}) {
  const repos = inventories.map((i) => i.repo).filter(Boolean).sort();

  const components = new Map(); // `${ecosystem}/${name}` → row
  const actions = new Map(); // `uses` → row
  const toolConfigs = new Map(); // path → row

  for (const inv of inventories) {
    for (const c of inv.components ?? []) {
      const key = `${c.ecosystem}/${c.name}`;
      const row =
        components.get(key) ??
        { name: c.name, ecosystem: c.ecosystem, type: c.type, versions: [], licenses: [], usedBy: [] };
      if (c.version) pushUnique(row.versions, c.version);
      for (const l of c.licenses) pushUnique(row.licenses, l);
      if (inv.repo) pushUnique(row.usedBy, inv.repo);
      // A package used as tooling anywhere is tooling in the catalog view.
      if (c.type === 'dev-tooling') row.type = 'dev-tooling';
      components.set(key, row);
    }
    for (const a of inv.actions ?? []) {
      const row = actions.get(a.uses) ?? { uses: a.uses, refs: [], unpinnedIn: [], usedBy: [] };
      if (a.ref) pushUnique(row.refs, a.ref);
      if (inv.repo) {
        pushUnique(row.usedBy, inv.repo);
        // A third-party action (has an owner/repo path) with no SHA is the
        // ENG-0005 finding; local `./` uses are exempt.
        if (!a.pinnedSha && !a.uses.startsWith('./')) pushUnique(row.unpinnedIn, inv.repo);
      }
      actions.set(a.uses, row);
    }
    for (const p of inv.toolConfigs ?? []) {
      const row = toolConfigs.get(p) ?? { path: p, usedBy: [] };
      if (inv.repo) pushUnique(row.usedBy, inv.repo);
      toolConfigs.set(p, row);
    }
  }

  const sortByUse = (a, b) => b.usedBy.length - a.usedBy.length || a.name?.localeCompare(b.name);
  const finalize = (row) => {
    row.versions?.sort();
    row.licenses?.sort();
    row.refs?.sort();
    row.usedBy.sort();
    row.unpinnedIn?.sort();
    return row;
  };

  return {
    schema: 'qwts.dependency-catalog/v1',
    generatedAt,
    repos,
    components: [...components.values()].map(finalize).sort(sortByUse),
    actions: [...actions.values()]
      .map(finalize)
      .sort((a, b) => b.usedBy.length - a.usedBy.length || a.uses.localeCompare(b.uses)),
    toolConfigs: [...toolConfigs.values()]
      .map(finalize)
      .sort((a, b) => b.usedBy.length - a.usedBy.length || a.path.localeCompare(b.path)),
  };
}

// Render the catalog as Markdown. Sorted most-shared-first, because the top of
// each table is the "already standard across the fleet, reuse this" answer.
export function renderCatalogMarkdown(catalog) {
  const lines = [];
  lines.push('# Fleet dependency & tooling catalog');
  lines.push('');
  lines.push(`Repos: ${catalog.repos.join(', ') || '(none)'}`);
  if (catalog.generatedAt) lines.push(`Generated at: ${catalog.generatedAt}`);
  lines.push('');

  lines.push('## Shared tooling (dev tools by fleet reach)');
  lines.push('');
  lines.push('| Tool | Ecosystem | Used by | Licenses |');
  lines.push('| --- | --- | --- | --- |');
  for (const c of catalog.components.filter((c) => c.type === 'dev-tooling')) {
    lines.push(`| ${c.name} | ${c.ecosystem} | ${c.usedBy.join(', ')} | ${c.licenses.join(', ')} |`);
  }
  lines.push('');

  lines.push('## GitHub Actions (pin status)');
  lines.push('');
  lines.push('| Action | Used by | Unpinned in |');
  lines.push('| --- | --- | --- |');
  for (const a of catalog.actions) {
    lines.push(`| ${a.uses} | ${a.usedBy.join(', ')} | ${a.unpinnedIn.join(', ') || '—'} |`);
  }
  lines.push('');

  lines.push('## Licenses in use');
  lines.push('');
  const byLicense = new Map();
  for (const c of catalog.components) {
    for (const l of c.licenses) {
      const set = byLicense.get(l) ?? new Set();
      set.add(c.name);
      byLicense.set(l, set);
    }
  }
  lines.push('| License | Package count |');
  lines.push('| --- | --- |');
  for (const [license, pkgs] of [...byLicense.entries()].sort((a, b) => b[1].size - a[1].size)) {
    lines.push(`| ${license} | ${pkgs.size} |`);
  }
  lines.push('');
  return lines.join('\n');
}
