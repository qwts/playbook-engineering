# Shared agent skills

Skills every agent in the fleet can use, centralized here per
[ENG-0004](../docs/decisions/ENG-0004-centralize-shared-cicd.md) — no per-repo
copies. They are agent primitives under
[ENG-0006](../docs/decisions/ENG-0006-agentic-primitives-governance.md): read as
directives, shipped with executable scripts, reviewed as code, and owned in
`.github/CODEOWNERS`.

## Available skills

None currently. The signed-commit skill moved to
[agent-bot-identity](https://github.com/qwts/agent-bot-identity), which owns
bot commit signing.

## Installing

Each skill's `SKILL.md` carries its own install line. They follow one shape —
symlink the skill directory into the harness so a `git pull` here updates every
machine, rather than copying and drifting:

```bash
PLAYBOOK_ROOT="$(git rev-parse --show-toplevel)"
ln -sfn "$PLAYBOOK_ROOT/skills/<name>" ~/.claude/skills/<name>
```

Distribution is manual today. Automating it — a worktree-create step, or a
plugin marketplace — waits until there are enough shared skills to justify the
machinery; the second skill added here is the signal that the manual step has
become the problem.

## Adding a skill

1. `skills/<name>/SKILL.md` with `name` and `description` frontmatter. The
   description is always in an agent's context while the body loads only when
   relevant, so it must say *when to use this* — that string is the whole
   trigger (ENG-0006 progressive disclosure).
2. Link it from **Available skills** above. `docs-gov` fails a skill reachable
   from no index: guidance nothing links to is guidance no agent loads.
3. Keep it under the `perDoc` token budget. A skill that needs more is usually
   two skills.
4. State what an agent cannot derive from the code or existing docs, and link
   rather than restate — a shared fact in two agent files is a bug
   (ENG-0006 item 1).
5. Treat any script it ships as the supply chain it is: no secrets, no network
   fetch of unpinned code, least privilege.
