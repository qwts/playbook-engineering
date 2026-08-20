# Dependency reuse policy

This is the operational cache contract selected by
[ENG-0269](../decisions/ENG-0269-trusted-dependency-reuse.md). Runtime failure
bounds remain in the [CI runtime policy](ci-runtime-policy.md).

## Shared action

Consumers pin `bounded-dependency-install` by immutable playbook commit SHA.
The action performs one ordered transaction:

1. derive an exact cache key from runner OS and architecture, ecosystem, exact
   toolchain/browser version, cache paths, and lockfile bytes;
2. restore that exact key without a broad fallback;
3. report cache provenance and run the installer through the bounded-command
   process-tree deadline; and
4. revalidate path custody and identity, then save a miss only during a push to
   the default branch.

```yaml
- uses: qwts/playbook-engineering/.github/actions/bounded-dependency-install@<reviewed-sha>
  env:
    NPM_CONFIG_CACHE: ${{ runner.temp }}/ci-dependency-cache/npm
  with:
    ecosystem: npm
    cache-paths: ${{ runner.temp }}/ci-dependency-cache/npm
    lockfiles: ui/package-lock.json
    toolchain-version: node-22.22.2
    task: Install locked dependencies
    executable: npm
    arguments-json: '["ci"]'
    working-directory: ui
    timeout-seconds: '300'
    attempts: '2'
```

## Trust boundary

Cached paths are unsigned inputs. They must be absolute children of
`runner.temp/ci-dependency-cache/<ecosystem>` and contain no secrets,
repository content, or installed trees. The action rejects symlinked cache
stores and revalidates path custody, lockfiles, and the cache key after install
before a save. Callers set the package manager's cache environment variable to
the same runner-owned path, so repository configuration cannot redirect it.
npm and Cargo then perform a clean lockfile installation with their integrity
checks. Pull requests restore only; the action never saves from a PR, manual
dispatch, fork, or feature push.

Merge-group caches are scoped to their temporary refs. When exact merge-group
evidence lets the complete `main` suite skip, the bounded post-merge smoke lane
runs the installer with the same key and seeds a miss in default-branch scope.
That lane does not repeat the complete suite. A new key can require one
default-branch origin download; unchanged keys restore from GitHub.

Allowed browser or OS caches require a pilot-specific immutable package list or
browser revision, trusted-main write evidence, and the same bounded cold path.
Do not share caches across OS, architecture, toolchain, browser revision, or
lockfile changes. Do not use restore prefixes that cross those boundaries.

GitHub documents that PR caches are ref-scoped and that cache contents are not
signed or verified; the stricter shared action makes the writer boundary
explicit: [dependency caching reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).

## Honest limits

A cache hit still downloads an archive to an ephemeral runner. A container is
also pulled per clean runner. A genuinely pre-warmed hosted image requires an
organization or enterprise larger runner and a dedicated image-generation
runner group; it is not part of the current decision:
[custom images](https://docs.github.com/en/actions/how-tos/manage-runners/larger-runners/use-custom-images).
