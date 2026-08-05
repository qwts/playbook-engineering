# ENG-0160: The semantic judge arbitrates size-ratchet adjustments

**Status:** Accepted
**Date:** 2026-08-04
**Issue:** qwts/playbook-engineering#160

## Context

image-trail and overlook enforce file-size ratchets: files under a ceiling may
grow to it, oversized legacy files are grandfathered but frozen, and new
oversized files fail. The ratchet is deterministic and cheap, and it cannot
tell relocation from design. The worked example is qwts/image-trail#786: a
550-line file tripped its ratchet, and the first fix moved a 258-line
enumeration into a new file — the number improved, the context footprint did
not. A length check structurally cannot make that distinction.

qwts/agentic-code-analysis ("aca") now provides the judgment the ratchet
lacks: `aca context-footprint` evaluates changed files against the
file-context-footprint standard (smallest practical context footprint that
still completely represents one coherent concept). It runs advisory in
image-trail CI as of qwts/image-trail#790; its first day of real verdicts
(2026-08-04) caught the relocation above and named the correct fix.

The ratchets had no adjustment process in either direction. Raising a limit
for one legitimately large file meant editing the global constant — relaxing
the whole repository to buy one exception. Trimming an oversized legacy file
had no trigger beyond its frozen number.

## Decision

The semantic judge is the arbiter for size-ratchet adjustments, in both
directions. The size check owns the numbers; the semantic check owns the
judgment; neither replaces the other. The contract stays conjunctive — a
change is good when it passes the ratchet AND the semantic check.

1. **Growth over the ceiling with a judge pass is grounds to raise, a
   little.** A pass on the grown file — one coherent concept whose splitting
   would *increase* the set of files a task must load — is the evidence for a
   per-file exception pinned at the new size. The global default never moves.
   Growth past the pinned number requires a fresh pass: an exception is a
   notch, not a blank check.

2. **Growth over the ceiling with a judge fail means the size was
   symptomatic.** No exception. The verdict names the seams to split along;
   the trim is scheduled as tracked debt rather than blocking the PR that
   happened to touch the file (qwts/agentic-code-analysis#13).

3. **Exception-granting requires the authoritative judge tier.** Measured
   2026-08-04: `claude-opus-5` consistently fails a file that
   `Qwen3-235B` consistently passes (qwts/agentic-code-analysis#12). A
   screen-tier judge would hand out ceiling raises for free. In ENG-0151
   terms, adjudication is T1-judgment work; cheaper tiers may screen but do
   not adjudicate.

4. **Exceptions are checked in and diff-visible.** A per-file map (path,
   pinned ceiling, the judge evidence) in the consuming repo, never a commit
   message or an environment variable — the exception list's growth rate is
   itself a health signal.

5. **Routine screening is cheap and advisory; exception adjudication is
   authoritative and rare.** A calibrated model reached through the Hugging
   Face OpenAI-compatible route screens changed files on ready pull requests.
   Its findings do not replace the deterministic ratchet and do not block a
   merge. The authoritative tier runs only when a per-file exception is
   requested or a screening verdict is disputed. Cost selects the screening
   route; calibration evidence selects an adjudicator.

6. **No model call runs in a commit or push hook.** Network availability,
   credentials, model latency, and billable retries do not belong in a local
   Git operation. Local semantic runs are explicit advisory commands. The
   shared CI lane runs once per ready pull-request revision and caches verdicts
   by their semantic inputs.

## Consequences

- The false choice between "relax the repo" and "never exceed the ceiling"
  goes away; the size ratchet stops being the thing agents satisfy by
  relocating code (qwts/image-trail#786 is the before/after evidence).
- Ratchet adjustment acquires a real cost: an authoritative-tier judgment
  per exception (cents) and a checked-in artifact per raise. That friction is
  intended — raises should be rare and visible.
- The two advisory-phase blockers identified at proposal time are closed in
  aca: account rejection now stops an enforcing or calibration run as gate
  down (qwts/agentic-code-analysis#11), and comparative judgments distinguish
  improvement from regression while retaining residual debt
  (qwts/agentic-code-analysis#13). A consuming repo still qualifies its exact
  provider, model, prompt, and fixture-suite tuple before relying on it.
- Judge verdicts are model judgments, not proofs. Verdict-stability across
  fresh runs (measured 3–4× today) and the graded self-test fixtures
  (qwts/agentic-code-analysis#12) are the calibration evidence; if a judge
  proves unstable on a file class, the exception process pauses for that
  class rather than averaging over noise.
- The consuming repos owe a small implementation: the exceptions map and the
  ratchet reading it. Until that lands, this record governs the manual
  process (owner grants the exception on judge evidence in the PR).

Operational adoption, qualification, and the two-dimensional decision matrix
are in [semantic ratchets](../reference/semantic-ratchets.md).
