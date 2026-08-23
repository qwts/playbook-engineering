# Documentation governance (docs-gov)

Deterministic CI checks that gate documentation the way code is gated, built on one premise: the primary reader of these docs is an agent, so the metric is **task success per token of context**, not readability. The tooling lives in [`tools/docs-gov/`](../../tools/docs-gov/docs-gov.mjs) in this repository and is consumed by every qwts repo through a reusable workflow. Decision record: [ENG-0009](../decisions/ENG-0009-documentation-governance-gate.md).

## The rules

Every rule must name the agent failure it prevents; a rule that cannot is not admitted, and a rule that false-positives on real docs is dropped rather than tolerated. `node tools/docs-gov/docs-gov.mjs --list-rules` prints this same list from the implementation.

| Rule | Checks | Agent failure it prevents |
| --- | --- | --- |
| `link-resolution` | Relative links and `#anchors` resolve | Following a dead link fails the task or invites fabricating the target |
| `orphan-doc` | Every doc reachable from an index | Unreachable guidance is never loaded by link-following retrieval |
| `stale-path` | Backticked repo paths exist (generated blocks exempt — their generator validates them) | The doc sends the agent to a file that moved or was deleted |
| `heading-structure` | One H1 first, no skipped levels, bounded depth | Heading-based chunking misparents sections, so chunks carry wrong context |
| `front-loaded-summary` | Prose states the point in the first N tokens | Truncated reads keep the preamble and lose the conclusion |
| `required-fields` | Machine-read fields (ADR `Status`) exist and parse | Field-reading gates silently pass or hard-fail on free-form values |
| `token-budget` | Per-doc and per-context-set ceilings, both directions | Unbudgeted growth crowds the task out of the context window |
| `positional-reference` | No `see above` / `as discussed below` | A retrieved chunk has no above or below; the reference dangles |
| `unresolved-placeholder` | No `TODO`/`TBD`/`FIXME` in normative text | An agent cannot distinguish a placeholder from a rule |
| `duplicate-statement` | No statement repeated across docs | Two copies drift into contradiction; the agent follows the stale one confidently |
| `terminology` | One name per concept (configured aliases) | Aliases split retrieval, making documented topics look undocumented |

## Conventions the gate enforces

**Tokens, not lines.** Budgets are measured in estimated tokens (bytes ÷ 4 — deterministic, dependency-free, vendor-neutral) because an agent pays per token; line counts hide the difference between a dense table and sparse prose.

**Budgets ratchet one direction.** The same discipline as the coverage and a11y floors in the app repos: exceeding a ceiling fails, and sitting far below an explicit override also fails ("bank the win" — lower the number). Raising any budget requires a `reason` recorded in the config, so growth is always an argued decision.

**Configuration is per-repo; the checks are not.** Each repo carries a `docs-gov.config.json` naming its include globs, indexes, budgets, required fields, and terminology map. photos can be strict where a scratch repo is loose, while the check implementations stay in one place and improve for everyone at once.

## Running locally

```bash
node tools/docs-gov/docs-gov.mjs
```

In this repository, `npm run docs:gov` does the same. Use `--root <dir>` to check another repo's checkout with its own config, `--report <file>` to write the JSON drift record, and `--list-rules` for the rule catalog.

## Consuming from another repo

```yaml
jobs:
  docs-gov:
    uses: qwts/playbook-engineering/.github/workflows/docs-governance.yml@v1
```

The reusable workflow checks out the caller's repo, fetches this repo's tooling, runs the gate against the caller's `docs-gov.config.json`, and uploads the JSON report as an artifact so token totals and finding counts are comparable across runs. The `v1` tag only moves after this repo's own CI has exercised the workflow (the ENG-0004 safety condition).

## What this deliberately does not do

- **No prose style, tone, or grammar rules.** Style is not an agent failure.
- **No model calls.** Every result is reproducible from a checkout; a check that needs a model is not a merge gate.
- **No effectiveness measurement.** Whether the docs actually *work* for agents is the job of [docs-eval](docs-evaluation.md) — the benchmark-driven evaluation loop adopted (with tight bounds) by [ENG-0010](../decisions/ENG-0010-docs-evaluation-loop.md). It runs on demand, costs model calls, and never blocks these checks.
