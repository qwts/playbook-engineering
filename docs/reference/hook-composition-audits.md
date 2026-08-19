# Hook composition audits

This record captures active-fleet surveys for repository-owned commands inside
the managed hook adapters. It supplements the composition contract in
[governed repository operations](governed-repos-operations.md); the manifest
remains the machine-readable source of ownership declarations.

## 2026-08-18 — Image Trail process guard

[Issue #233](https://github.com/qwts/playbook-engineering/issues/233)
audited `.claude/settings.json`, `.codex/hooks.json`, and
`.cursor/hooks.json` on the default branch of every active manifest repository:
33 adapter files across 11 repositories. The audited heads were:

- `playbook-engineering@68b920af61725d3107e9a7d4c151f7c06616bda4`
  and `overlook@c8e7e012a3ff9d86b29bc189436cb415a2785e11`;
- `image-trail@5246642f372ee4153d1b709601807e1a2975338f`
  and `cartograph@2d27e5d7a38989ae9f9f818aafe2b5d2f5a282b9`;
- `bookmarkit@833b9b8fe1f50bd61fa3d917347107bca7fd4cb5`
  and `quorum@0f2cc7829d82091ea9cadaf046c6731ab7d69dc3`;
- `agent-bot-identity@62f3b043fb9b03643bb5c78f7f9aded7dee5991f`
  and `codex-rules-editor@a9cefa03c6ff63079191e187d008a06a918c3c3c`;
- `playbook-dashboard@9e90d9525cfe081638fdf0e945b9d17611e5f795`
  and `agentic-code-analysis@f3639dd60ba67d0681345262d83e0ca013e7a0fe`;
- `localnotes@92e50663960ceef41c741ee9aea25d0856cfa511`.

The only undeclared repository-owned command was Image Trail's Claude
`SessionStart` process guard, `scripts/guard-session-context.mjs`. Its stable
path marker is declared for `.claude/settings.json`, so synchronization
composes it with the centrally owned identity `SessionStart` hook.

Image Trail's `check:agent-env` also checks the `PreToolUse` command
`tools/agent-guard/guard-agent-command.mjs`. That hook is centrally owned and
already propagates from the canonical Claude settings, so it needs no
preservation declaration. The existing `agent-bot-identity` declarations
remain necessary because that repository generates its own
`agent-bot agent-hook` entries. No other repository-specific command or new
manifest declaration was found.

After the source fix merges, the governed synchronization workflow must
regenerate [Image Trail PR #837](https://github.com/qwts/image-trail/pull/837)
from the merged playbook commit. Do not repair the downstream adapter by hand;
the regenerated head is where `npm run check:agent-env` and the complete Image
Trail suite provide hosted acceptance evidence.
