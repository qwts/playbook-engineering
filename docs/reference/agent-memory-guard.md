# Machine memory guard

Local machines have one memory budget, shared by every repo, worktree and agent
tool on them. This guard is what makes that budget real: it derives limits from
the machine, checks live availability and swap before a run starts, and
coordinates through per-machine leases so concurrent agent sessions can see each
other. Decision record: [ENG-0138](../decisions/ENG-0138-machine-scoped-agent-memory-budget.md).
The tooling lives in [`tools/agent-guard/`](../../tools/agent-guard/run-guarded.mjs)
and reaches governed repos through the fleet harness sync.

**The wrapper has no CI exemption.** Environment markers, runner-looking paths,
and GitHub OIDC job credentials are all transferable to another process, so
none can prove where the current wrapper is executing. GitHub workflows retain
a reliable no-op path by invoking their underlying CI commands directly rather
than entering this local-machine wrapper.

## Limits, and where they come from

Nothing is a constant. On a machine with `T` MB of RAM:

| Quantity | Formula | On 8 GB | On 32 GB |
| --- | --- | --- | --- |
| Desktop reserve | `max(1536, T×0.25)` | 2048 MB | 8192 MB |
| Machine budget | `T − reserve` | 6144 MB | 24576 MB |
| Max per run | `min(2048, budget ÷ 2)` | 2048 MB | 2048 MB |
| Availability floor | `max(768, T×0.125)` | 1024 MB | 4096 MB |
| Light run | `min(floor ÷ 2, cap ÷ 2)` | 512 MB | 1024 MB |

A requested ceiling is **clamped down** to the per-run cap and never up: asking
for less than the cap always works, asking for more never does. This is what
turns an inherited `--rss-mb 8192` from an unreachable ceiling into an
enforceable one. The 2048 MB lane cap is absolute: the incident this guard
exists for was one test lane ballooning to ~100 GB of committed memory, and no
sanctioned local lane needs more. The cap is enforced on the running process
tree, and what admission *reserves* is smaller still when the lane has a
recent measured peak: peak plus a conservative margin, so a lane that
measures well under the cap no longer books the full cap against admission.
Peak history is keyed by the checkout's canonical Git common directory, lane
label, exact argv, and a versioned behavior HMAC. Reuse requires a clean exact
revision and binds the resolved executable, canonical absolute cwd, full child
environment, and raw plus structural `PWD`, `INIT_CWD`, and `PATH` evidence.
Linked worktrees share the protected namespace, but child-visible path
differences keep peaks separate. Direct Node and supported sh-family files, and
Python `-S` file forms, bind canonical entry-file metadata and SHA-256; stdin,
inline, module, startup-path, unsupported-shell, indirect-wrapper,
package-manager, and named transitive tool dispatchers stay cold. Runtime
recognition uses canonical names; a copied or renamed runtime stays cold for
no-arg, stdin, option, or filesystem-target argv. Other unrecognized
executables use exact native argv evidence, without claiming hermetic network
or transitive-input closure. Dirty, staged, untracked, non-Git,
assume-unchanged, skip-worktree, or otherwise unprovable states stay cold. Only
the two root-owned `.guard` diagnostics are ignored. Thus #223 Finding 1 stays
open pending immutable, path-invariant package provenance; this policy fixes
Finding 2 without letting declared ceilings buy the light-run exemption.

## Admission

A run is granted only if all three hold:

1. **Pressure and swap.** On macOS the kernel's live pressure level outranks
   static swap arithmetic in both directions: warning/critical refuses a heavy
   run outright, and normal (green) pressure retires committed-but-idle swap as
   evidence — macOS keeps swap allocated after pressure subsides. Without
   pressure evidence, refused when swap is at least 50% committed. Either gate
   spares only lanes whose recent measured peak is no larger than the light-run
   size. An unmeasured lane is not light, and lowering a caller-declared ceiling
   cannot claim the exemption. A machine already trading pages for progress is
   one more Electron worker away from a freeze.
2. **Headroom.** `available − (what running leases have not yet materialized) −
   this request` must stay above the availability floor. Availability comes from
   `vm_stat` and `sysctl vm.swapusage` on macOS, `/proc/meminfo` on Linux.
3. **Budget.** Outstanding leases plus this request must fit the machine budget.

Leases heartbeat their real tree RSS, so a warmed-up run stops being counted
twice — its resident memory is already reflected in what the kernel reports as
available. After spawn, the lease follows the detached process group rather
than the wrapper PID. If the wrapper is force-killed while descendants remain,
their group stays live and continues holding the reservation.

Reading the leases, deciding and taking the lease happen under one machine-wide
mutex, so two runs starting at the same moment cannot both be admitted against
the same snapshot. A run that has to queue releases the mutex between attempts.

A refusal prints the arithmetic, the other runs holding budget, and the largest
resident processes, so it can be acted on rather than merely retried.

## Agents and the owner

Agents are denied these lanes locally by default:

| Lane | Why it is heavy |
| --- | --- |
| `e2e` | every Playwright worker boots a full Electron app |
| `stories` | a Storybook build plus a browser-driven test run |
| `perf` | seeds a large synthetic library |
| `coverage` | instruments the whole suite |
| `full-ci` | chains lint, typecheck, the suites and a build |

**An agent's correct move is to push and let GitHub CI verify.** CI is the
authoritative lane. Its workflow invokes the underlying CI entrypoint directly,
so nothing is lost but latency and no process-local signal has to authorize a
wrapper bypass.

Every caller that enters the local wrapper fails closed as an agent because an
unmarked process and a same-user file cannot authenticate owner intent. Heavy
lanes are therefore not delegable back to an agent session and legacy grant
files are cleanup artifacts only.

If a local heavy run is genuinely required, the agent reports the refusal and
the owner decides whether to invoke the underlying lane directly from a
non-agent terminal. That is an explicit owner exception **outside** this
wrapper: it does not acquire a lease or receive admission, RSS-ceiling, or
timeout enforcement. CI remains the protected and authoritative heavy lane.
`AGENT_GUARD_FORCE=1` can override an admission refusal only after a command has
passed lane policy; it does not authorize a heavy agent run.

## Commands

```bash
node tools/agent-guard/arbiter.mjs status
```

Machine limits, live availability and swap, every lease on the machine with the
repo and harness holding it, and any legacy grant artifacts awaiting
revocation. `check --rss-mb N` dry-runs an admission decision and exits
non-zero when it would be refused; `doctor` verifies the probes and reports the
resolved state directory.

Wrapping a command:

```bash
node tools/agent-guard/run-guarded.mjs --label test:dom -- npm run test:dom:inner
```

The wrapper directly spawns exact argv in its own process group and starts an
asynchronous RSS sample before the 250 ms polling interval. Peak history needs
positive live-target samples spanning at least one full interval; a missed fast
target or startup-only transient stays cold. Breaches get `SIGTERM`, then
`SIGKILL` after 2 s or immediately past
1.25× the ceiling. Diagnostics use `.guard/last-run.json` and
`.guard/history.jsonl` at the worktree root (or cwd outside Git); `rss-limit`
and `timeout` exit non-zero.

## Environment

| Variable | Effect |
| --- | --- |
| `AGENT_GUARD_RSS_MB` | Requested tree ceiling, still clamped to the machine cap |
| `AGENT_GUARD_HEAP_MB` | Per-process V8 heap; defaults to half the tree ceiling |
| `AGENT_GUARD_TIMEOUT_S` | Wall-clock timeout, `0` disables |
| `AGENT_GUARD_WAIT_S` | How long to queue for headroom; humans default to 180, agents to 0 |
| `AGENT_GUARD_FORCE` | Overrides admission after lane policy; never authorizes a heavy agent run |
| `AGENT_GUARD_STATE_DIR` | Lease directory. **Tests only** — pointing a session elsewhere gives it a private budget nothing can see, which is the per-worktree bug again |
| `AGENT_GUARDED` | Set by the guard for its own children, carrying the id of the lease it holds, so nested guarded scripts pass through. Honoured only when it names a live lease bound to the caller's own process group — a copied or hand-supplied value from an unrelated process is ignored and the run is guarded normally. Blocked for agents |

## Adopting it in a repo

The files arrive by harness sync. A consuming repo then:

1. Points its guarded npm scripts at `tools/agent-guard/run-guarded.mjs` and
   deletes any local fork of the old guard.
2. Points hosted workflows at the underlying CI scripts rather than the guarded
   local aliases. No CI marker, runner path, or job credential changes wrapper
   policy.
3. Removes heavy lanes from `permissions.allow` in `.claude/settings.json` —
   pre-approving them is how they became routine.
4. Adds `tools/agent-guard/tests/conformance.test.mjs` to its test command. This
   is not optional: it is what fails a future sync that drops the hook wiring,
   which has already happened once.
5. Rewrites its `AGENTS.md` validation section to say push-and-let-CI-verify
   rather than run-the-suites-locally.

## Limitations

- Polling at 250 ms lets a fast enough runaway overshoot briefly before
  `SIGTERM` lands; the 1.25× hard kill bounds the tail. There is no unprivileged
  macOS API for a hard aggregate-RSS cap on a process tree.
- Admission is advisory. It orders honest participants — anything started
  outside the wrapped entrypoints is invisible to it, and shows up only as
  reduced availability for everyone else.
- The guard cannot see memory pressure caused by applications rather than runs,
  beyond what the availability and swap readings already reflect.
- GitHub does not provide a job credential bound to the current process or
  machine. Its OIDC request credential is a transferable bearer credential, so
  the wrapper deliberately has no hosted-CI detection or bypass.
- Windows falls back to passthrough; the probes target macOS and Linux.
