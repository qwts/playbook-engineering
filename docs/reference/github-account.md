# GitHub account — maintained baseline

Reference for the account these repos live under, so decisions and tooling
assume the right tier instead of guessing. For *which* repos are governed, the
source of truth is the manifest behind [governed-repos.md](governed-repos.md)
([ENG-0011](../decisions/ENG-0011-governed-scope-manifest.md)); repo names below
are illustrative of the account tier, not an inventory.

## The account

- **Account:** `qwts` — an **individual (user) account**, not an organization.
- **Plan:** **GitHub Pro**. This is the paid, maintained baseline. Decisions
  should assume Pro — not Free (understated), and not an org or Enterprise
  (not in place).

## What Pro provides that is relied upon

- **Protected branches / rulesets on private repositories.** On an individual
  account this requires Pro; Free gives rulesets only on public repos. So the
  private repos (`universal-agentic-workflow`, `inventory-app`, …) can carry the
  same branch protection the public ones do.
- **Larger bundled GitHub Packages storage and Actions minutes** than Free —
  which is why a private package registry (e.g. the shared-scripts package
  deferred in [ENG-0004](../decisions/ENG-0004-centralize-shared-cicd.md)) needs
  no third-party service.
- **Actions minutes for private repositories.**

Public repos get rulesets, Pages, and Actions regardless of tier, so the
public projects (`photos`, `image-trail`, this repo, …) do not depend on Pro
for their CI.

> **Exact quotas move.** GitHub adjusts included storage and minutes over time.
> Treat the numbers in GitHub's own billing settings as authoritative rather
> than pinning figures here; this doc records the **tier and what depends on
> it**, not the current quota values.

## Implications for decisions

- **No organization is in place, by design.** The forcing function to create one
  is adding collaborators (see [ENG-0001](../decisions/ENG-0001-cross-repo-decision-home.md)),
  which has not happened. Pro already covers private-repo branch protection, so
  that is *not* a reason to form an org.
- **Third-party registries/CI add-ons are redundant** with capability already
  bundled in Pro. Evaluate any such purchase against "what does Pro already give
  me," not against the vendor's anchor price.

## Revisit when

- Collaborators are added → reassess an organization (and its Team/Enterprise
  tiers) at that point.
- A **private Python (PyPI) or Rust (Cargo)** package is needed → GitHub
  Packages does not host those first-class; that is the one registry gap Pro
  does not close.
