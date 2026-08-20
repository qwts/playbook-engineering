# ENG-0269: Reuse immutable dependency downloads on standard hosted runners

**Status:** Proposed
**Date:** 2026-08-20
**Issue:** qwts/playbook-engineering#269

## Context

Every standard GitHub-hosted job starts clean. Back-to-back PRs therefore
repeat npm, Cargo, browser, and OS downloads even when their lockfiles and
toolchains are identical. Cartograph demonstrated the cost when Ubuntu and
Playwright origins stalled several concurrent jobs.

The repositories are user-owned, while GitHub custom images require
organization or enterprise larger runners. No recurring runner cost or
self-hosted custody boundary has been accepted. GitHub also warns that cache
contents are unsigned and may become executable after restore.

## Decision

Use standard GitHub-hosted runners plus the shared bounded dependency-install
action as the fleet default. It restores an exact GitHub Actions cache, runs
the #267 bounded cold-path installer, revalidates the store, then saves a miss
only during a trusted default-branch push.

Cache identity includes runner OS, architecture, ecosystem, exact toolchain or
browser version, cache-path set, and the digest of exact lockfiles. There are
no broad restore keys. Cache only download stores; never cache `node_modules`,
Cargo `target`, virtual environments, credentials, or repository contents.
Package-manager integrity and repository lockfiles remain authoritative.

Cache paths must be absolute children of the runner-owned
`runner.temp/ci-dependency-cache/<ecosystem>` subtree. The shared action rejects
symlinked stores and revalidates both path custody and cache identity after the
installer, before any save. Callers explicitly point each package manager at
that same path instead of accepting repository-controlled cache configuration.

Pull requests may restore the trusted default-branch cache but cannot publish
one through the shared action. Every run logs the key, hit state, and write
policy. Browser and OS pilots must additionally prove their package or browser
revision verification and keep a bounded origin-download fallback.

A merge-queue candidate validates the exact combined commit, but its cache is
scoped to the temporary queue ref. After that evidence succeeds, the bounded
post-merge smoke lane installs from the same exact key and seeds a miss in the
default-branch scope. This is not a second complete suite. A new key may require
one default-branch origin download; later identical jobs restore the cache.

## Consequences

- Warm identical jobs restore from GitHub instead of stampeding package origins.
- Standard runners still transfer cache archives and cold misses still reach
  origins; this is reduction and isolation, not zero network transfer.
- Toolchain or lockfile skew creates a miss rather than reusing incompatible
  bytes.
- A caller cannot redirect the shared cache into a workspace, credential path,
  installed tree, or another ecosystem's store.
- Default-branch pushes become the only cache writers and may race harmlessly
  on the same immutable key.
- The validated post-merge lane seeds default-branch scope when merge-queue
  evidence lets the complete `main` suite skip.
- A future organization migration may reconsider a larger-runner custom image
  with explicit cost, image custody, SBOM, scan, provenance, and rollback.

## Alternatives

- **Larger runner custom image:** deferred because the current user-owned
  repositories cannot use the organization-only substrate and cost is unapproved.
- **Ephemeral self-hosted image:** rejected for now because public-repository
  isolation, patching, credentials, and incident response need separate custody.
- **Cache installed trees:** rejected because mutable executable state can bypass
  clean lockfile installation and expands cache-poisoning impact.
