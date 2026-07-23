// Tiny glob→RegExp for config patterns. Supports **, *, ? over /-separated
// repo-relative paths. Deliberately not a full glob engine — config patterns
// are written by us, and a dependency here would defeat the bare-checkout
// zero-install property the reusable workflow relies on. Kept local to this
// tool so dependency-inventory does not couple to docs-gov's internal layout.

export function globToRegExp(pattern) {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` matches zero or more whole segments; bare `**` matches rest.
        if (pattern[i + 2] === '/') {
          out += '(?:[^/]+/)*';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(out + '$');
}

export function matchesAny(p, patterns) {
  return patterns.some((pat) => globToRegExp(pat).test(p));
}
