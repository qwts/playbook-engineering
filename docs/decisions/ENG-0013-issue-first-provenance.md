# ENG-0013: ENG records are issue-first — the issue holds the why, the record holds the decision

**Status:** Proposed
**Date:** 2026-07-23
**Issue:** qwts/playbook-engineering#22

## Context

Records and amendments have been created without a linked GitHub issue
defining why they exist. That loses the originating discussion, leaves no
home for future discussion, and risks records created for their own sake.
Concretely: [ENG-0011](ENG-0011-governed-scope-manifest.md) was drafted from
a working-session discussion the repo cannot cite. The practice already
existed unevenly — ENG-0009 references its issue — but nothing required it.

## Decision

1. **Every new ENG record and amendment cites its originating GitHub issue**
   in an `**Issue:**` header field, alongside `Status` and `Date`.
2. **The issue is the discussion home; the record is the durable outcome.**
   Problem statement, requirements, and alternatives live on the issue.
   Reopening debate happens on the issue; changing the decision happens in
   the series, by amendment or supersession.
3. **Machine-enforced, not conventional.** docs-gov's `requiredFields` gains
   the `Issue` field for `docs/decisions/ENG-*.md`. New records must match a
   real reference (`qwts/<repo>#<n>`) — the escape value below is accepted
   *only* for the grandfathered files, scoped by exclusion globs, so a later
   record cannot reuse it to dodge the rule.
4. **ENG-0001 through ENG-0010 carry the escape value**
   `predates issue-first (ENG-0013)`. Backfilling retroactive issues for
   settled decisions with no live discussion would be the ceremony this rule
   exists to prevent; the escape value records history honestly instead. A
   grandfathered record may still upgrade to a real reference if a live
   discussion ever earns one.
5. **The gate doubles as a filter.** A record with no real problem behind it
   has no issue to cite — which is exactly the point.

## Consequences

- Friction by design: an issue must exist before a record lands. For
  decisions born in working sessions, the discussion must be distilled into
  an issue first — the issues behind this very batch were written that way.
- The escape value is permanent in ten records' headers; a reader must know
  it means "before the rule," not "no reason existed."
- Issue references are plain text, not links — greppable and stable, but a
  reader must open GitHub for the discussion. Accepted: the alternative,
  restating the why in the record, is the duplication this series avoids.
- If issues are ever migrated off GitHub, eleven-plus references need a
  mapping. Accepted as a distant risk; the tracker choice is itself an ENG
  decision if it ever changes.

## References

- qwts/playbook-engineering#22 — the originating issue
- [ENG-0007](ENG-0007-feature-lifecycle-convention.md) — issue-first for features; this record applies the same shape to decisions
- [Decision index](README.md) — format section documents the field
