// Detect which agent harness (IDE/CLI) is running from the ambient environment
// each tool sets on its own, and map it to that harness's bot slug (ENG-0016).
// This is what makes the bot identity match the IDE with zero per-tool setup:
// the tool announces itself through env vars it already exports, and this
// resolver reads them. No configuration files, no per-repo state.
//
// Order matters: Cursor and VS Code both set TERM_PROGRAM=vscode (Cursor is a
// VS Code fork), so Cursor's own marker must be tested first. Add a harness by
// adding a row — first row whose `match` returns true wins.

const HARNESSES = [
  {
    slug: 'qwts-claude-agent',
    match: (e) => e.CLAUDECODE === '1' || (e.AI_AGENT ?? '').startsWith('claude') || (e.CLAUDE_CODE_ENTRYPOINT ?? '') !== '',
  },
  {
    slug: 'qwts-codex-agent',
    match: (e) =>
      Object.keys(e).some((k) => k.startsWith('CODEX_')) || (e.AI_AGENT ?? '').includes('codex'),
  },
  {
    slug: 'qwts-cursor-agent',
    match: (e) =>
      Object.keys(e).some((k) => k.startsWith('CURSOR_')) ||
      (e.__CFBundleIdentifier ?? '').toLowerCase().includes('cursor'),
  },
  {
    slug: 'qwts-vscode-agent',
    match: (e) =>
      e.TERM_PROGRAM === 'vscode' ||
      Object.keys(e).some((k) => k.startsWith('VSCODE_')) ||
      (e.__CFBundleIdentifier ?? '').toLowerCase().includes('com.microsoft.vscode'),
  },
];

// Returns the bot slug for the detected harness, or null if none matched.
export function detectHarness(env = process.env) {
  for (const h of HARNESSES) {
    try {
      if (h.match(env)) return h.slug;
    } catch {
      /* a malformed env value must never throw the resolver */
    }
  }
  return null;
}

export { HARNESSES };
