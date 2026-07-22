# Contributing

This repository is the org's cross-repo home for engineering decisions (ENG
records), shared SOPs, and reusable CI. How work moves here:

- **Decisions**: new or changed cross-repo direction lands as an ENG record —
  format, numbering, and the supersede-don't-rewrite rule are in
  [docs/decisions/README.md](docs/decisions/README.md). Records enter as
  `Proposed`; the repo owner flips them to `Accepted` in review.
- **SOPs**: shared procedures live in [docs/sop/](docs/sop/) and follow
  [ENG-0008](docs/decisions/ENG-0008-shared-sop-inheritance.md) — baseline
  edits here propagate to every repo, so changes go through PR review with
  the changelog updated.
- **Workflow**: branch → PR → review → merge to `main`. Features follow the
  [feature-lifecycle SOP](docs/sop/feature-lifecycle.md)
  ([ENG-0007](docs/decisions/ENG-0007-feature-lifecycle-convention.md)):
  problem, requirements, design, proposed patterns at open; closeout at close.
- **Shared CI** ([ENG-0004](docs/decisions/ENG-0004-centralize-shared-cicd.md)):
  reusable workflows are consumed by other repos at `@v1`; never move the tag
  without the playbook-side CI gate green.
