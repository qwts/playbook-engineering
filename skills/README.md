# Shared agent skills

This repository is the fleet's central skills home and catalog, not a
copy of every implementation. The `skills/` tree here is empty of skill
directories today. The two skills under Available skills live in owner
repos and are installable on a real machine (Mac / workstation). They
are not skills for Cursor cloud agents or other cloud VMs: those
sessions must not clone the owner repos, and must not run those skills,
installers, or CLIs. A skill that later lands here is an
[ENG-0006](../docs/decisions/ENG-0006-agentic-primitives-governance.md)
primitive: read as a directive, shipped with executable scripts, reviewed
as code, and owned in `.github/CODEOWNERS`.

## Catalog vs home

- **Home / index:** this file. Agents look here to learn what exists
  for the fleet. `docs-gov` enrolls markdown that exists in this
  checkout, so an external skill is advertised by owner-repo URL, not by
  a dummy folder under `skills/`.
- **Implementation:** the owner repo linked from each Available skills
  entry. A real machine installs from that checkout or its documented
  distributor. Do not copy the skill into this repository. Cursor cloud
  agents and other cloud VMs do not install these implementations.

## Available skills

These two are advertised as installable on a real machine (Mac /
workstation). They are not for Cursor cloud agents or other cloud VMs.

- **[agent-bot](https://github.com/qwts/agent-bot-identity/tree/main/skills/agent-bot)**
  in [agent-bot-identity](https://github.com/qwts/agent-bot-identity) —
  workstation bot-identity bootstrap, credential minting, verified
  commits, and Agent Spaces. Reference docs live in that skill's
  [references](https://github.com/qwts/agent-bot-identity/tree/main/skills/agent-bot/references)
  directory. This skill absorbed the old signed-commit skill. That
  repository is not set up to run in cloud environments.
- **[managed-machine](https://github.com/qwts/managed-machine/blob/main/skills/SKILL.md)**
  v0.3.19 in [managed-machine](https://github.com/qwts/managed-machine) —
  Mac workstation bootstrap and update via the Homebrew formula. That
  repository is not set up to run in cloud environments.

The signed-commit skill used to live here and moved into agent-bot. A
workstation that installed it from this repo has a dangling symlink;
remove it there (not on a cloud VM):

```bash
rm -f ~/.claude/skills/signed-commit
```

## Installing

Skills that later land in this repository follow one shape — each
`SKILL.md` carries its own install line, and the harness on a real
machine gets a symlink so a `git pull` here updates every workstation,
rather than copying and drifting:

```bash
PLAYBOOK_ROOT="$(git rev-parse --show-toplevel)"
ln -sfn "$PLAYBOOK_ROOT/skills/<name>" ~/.claude/skills/<name>
```

Skills listed from other repos use the install line in that repo's
`SKILL.md`, or the Homebrew formula for managed-machine, on a real
machine only. A Cursor cloud agent or other cloud VM must not clone
those repos or run those installers, skills, or CLIs. Do not symlink
them from this checkout; the directories are not here.

Distribution of skills that land here is manual today. Automating it —
a worktree-create step, or a plugin marketplace — waits until there are
enough shared skills in this home to justify the machinery; the second
skill added here is the signal that the manual step has become the
problem.

## Adding a skill

1. For a skill that lands in this home: `skills/<name>/SKILL.md` with
   `name` and `description` frontmatter. The description is always in an
   agent's context while the body loads only when relevant, so it must
   say *when to use this* — that string is the whole trigger (ENG-0006
   progressive disclosure). For a skill that stays in an owner repo: add
   an Available skills entry with that repo's URL and whether a cloud
   agent may run it; do not create a placeholder directory here.
2. Link it from **Available skills**. `docs-gov` fails a local skill
   reachable from no index: guidance nothing links to is guidance no
   agent loads.
3. Keep a local skill under the `perDoc` token budget. A skill that
   needs more is usually two skills.
4. State what an agent cannot derive from the code or existing docs, and
   link rather than restate — a shared fact in two agent files is a bug
   (ENG-0006 item 1).
5. Treat any script it ships as the supply chain it is: no secrets, no
   network fetch of unpinned code, least privilege.
