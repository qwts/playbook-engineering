# ENG-0006 conformance checklist

The test for whether a repo is aligned with [ENG-0006](../decisions/ENG-0006-agentic-primitives-governance.md) §6, for the per-repo alignment issues to link to instead of restating: qwts/playbook-engineering#7 (this repo), qwts/photos#718, qwts/image-trail#688, qwts/cartograph#262, qwts/bookmarkit#64.

A repo is conformant when all four hold.

## a. AGENTS.md exists and is canonical

- [ ] A root `AGENTS.md` exists.
- [ ] It is the fullest, most current statement of agent context in the repo — not a pointer stub that defers to a vendor file.

## b. Vendor files are thin adapters

- [ ] Every vendor instruction file (`CLAUDE.md`, `.github/copilot-instructions.md`, `.cursor/rules`, etc.) opens by pointing to `AGENTS.md`.
- [ ] No shared fact appears in both `AGENTS.md` and a vendor file. Content that is genuinely vendor-specific (a Copilot custom-agent chain, a Claude-only tool permission) may stay in the vendor file.

## c. Progressive-disclosure review passed

- [ ] The root file reads as a map — short orientation, links for depth — not a manual.
- [ ] Nothing in it is derivable from the code, CI config, or existing docs.
- [ ] Every length increase since the last review has a stated reason.

## d. Agent-facing supply chain is pinned and least-privilege

- [ ] MCP servers and third-party skills used by the repo are allow-listed and pinned (version or hash).
- [ ] Tool permissions (`settings.json` or the vendor equivalent) grant least privilege.
- [ ] No secrets appear in any agent-facing file.

## Also checked, org-wide

- [ ] The repo's `AGENTS.md` links to [org-wide agent conventions](agent-conventions.md) for the shared working agreement rather than restating it.
- [ ] Interactive vendor primitives (custom agents, slash commands, skills) have been reviewed as code and deduped against `docs/`, per ENG-0006's "genuinely vendor-specific" carve-out in decision item 1.
