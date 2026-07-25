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

// Deliberately narrower than detectHarness: these markers identify an agent
// process, not merely a human terminal opened inside an editor. Security
// guards use this resolver when allowing stock human credentials would cross
// the agent/human identity boundary.
export function detectAgentHarness(env = process.env) {
  const explicit = typeof env.GH_AGENT_APP === 'string' ? env.GH_AGENT_APP : '';
  if (/^qwts-(?:claude|codex|cursor|vscode)-agent$/.test(explicit)) return explicit;

  const aiAgent = typeof env.AI_AGENT === 'string' ? env.AI_AGENT.toLowerCase() : '';
  if (
    env.CLAUDECODE === '1' ||
    (typeof env.CLAUDE_CODE_ENTRYPOINT === 'string' && env.CLAUDE_CODE_ENTRYPOINT !== '') ||
    aiAgent.includes('claude')
  ) {
    return 'qwts-claude-agent';
  }
  if (Object.keys(env).some((key) => key.startsWith('CODEX_')) || aiAgent.includes('codex')) {
    return 'qwts-codex-agent';
  }
  if (aiAgent.includes('cursor')) return 'qwts-cursor-agent';
  if (aiAgent.includes('vscode')) return 'qwts-vscode-agent';
  return null;
}

export { HARNESSES };
