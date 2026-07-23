// CycloneDX SBOM → normalized components.
//
// Syft emits CycloneDX JSON; this reads the one shape we rely on (components
// with a purl and an optional licenses array) and drops the rest. The license
// detection is Syft's, deliberately — reproducing SPDX matching by hand is the
// wheel ENG-0011 chose not to reinvent.

// purl looks like `pkg:npm/@scope/name@1.2.3` or `pkg:cargo/serde@1.0.0`.
// The ecosystem is the token between `pkg:` and the first `/`.
function ecosystemFromPurl(purl) {
  if (typeof purl !== 'string') return 'unknown';
  const m = /^pkg:([^/]+)\//.exec(purl);
  return m ? m[1].toLowerCase() : 'unknown';
}

// CycloneDX licenses entries take three shapes; normalize all to a flat list of
// strings. An SPDX `id` is preferred, a free-form `name` is kept as-is, and an
// `expression` (e.g. "(MIT OR Apache-2.0)") is kept whole. Missing/empty →
// UNKNOWN, so a license gap is visible in the inventory rather than silent.
function licensesOf(component) {
  const out = [];
  for (const entry of component.licenses ?? []) {
    if (entry?.license?.id) out.push(entry.license.id);
    else if (entry?.license?.name) out.push(entry.license.name);
    else if (entry?.expression) out.push(entry.expression);
  }
  return out.length ? [...new Set(out)] : ['UNKNOWN'];
}

// Parse a CycloneDX document into the component rows the inventory keeps.
// Throws with a clear message when the file is not a CycloneDX BOM, so a bad
// --sbom path fails loudly instead of producing an empty inventory.
export function parseSbom(raw) {
  const bom = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!bom || bom.bomFormat !== 'CycloneDX') {
    throw new Error('not a CycloneDX SBOM (expected bomFormat "CycloneDX")');
  }
  const components = [];
  for (const c of bom.components ?? []) {
    if (!c?.name) continue;
    components.push({
      name: c.group ? `${c.group}/${c.name}` : c.name,
      version: c.version ?? null,
      ecosystem: ecosystemFromPurl(c.purl),
      licenses: licensesOf(c),
      purl: c.purl ?? null,
    });
  }
  // Stable order: ecosystem, then name, then version — so two runs of the same
  // input diff to nothing.
  components.sort(
    (a, b) =>
      a.ecosystem.localeCompare(b.ecosystem) ||
      a.name.localeCompare(b.name) ||
      String(a.version).localeCompare(String(b.version)),
  );
  return components;
}
