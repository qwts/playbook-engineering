# Machine memory guard

Local machines have one memory budget, shared by every repo, worktree and agent
tool on them. This guard is what makes that budget real: it derives limits from
the machine, checks live availability and swap before a run starts, and
coordinates through per-machine leases so concurrent agent sessions can see each
other. Decision record: [ENG-0138](../decisions/ENG-0138-machine-scoped-agent-memory-budget.md).
The tooling lives in [`tools/agent-guard/`](../../tools/agent-guard/run-guarded.mjs).
ENG-0138 is still Proposed, and only accepted decisions ship: the guard is not
distributed by the harness sync and no harness adapter registers it (#331).

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
tree. Admission currently reserves that full ceiling for every automatic run.
`run-guarded` neither reads nor records lane peak history: 250 ms polling cannot
prove a process-tree high-water mark, and arbitrary commands can consume
inherited stdin or mutable transitive inputs. Existing protected-store entries
are ignored. Lower-level peak and behavior-identity APIs remain dormant for a
future design backed by OS high-water evidence and immutable, path-invariant
input provenance. Thus #223 Finding 2 is fixed — a declared ceiling cannot buy
the light-run exemption — while automatic measured-light reuse from Finding 1
remains open.

## Admission

A run is granted only if all three hold:

1. **Pressure and swap.** On macOS the kernel's live pressure level outranks
   static swap arithmetic in both directions: warning/critical refuses a heavy
   run outright, and normal (green) pressure retires committed-but-idle swap as
   evidence — macOS keeps swap allocated after pressure subsides. Without
   pressure evidence, refused when swap is at least 50% committed. Either gate
   can spare only a lane with separately proven evidence no larger than the
   light-run size. The production wrapper supplies no such evidence, so every
   automatic run is cold; lowering a caller-declared ceiling cannot claim the
   exemption. A machine already trading pages for progress is one more Electron
   worker away from a freeze.
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
asynchronous RSS sample before the 250 ms polling interval. Samples enforce the
ceiling, heartbeat leases, and populate per-run diagnostics only; they never
seed admission history. Breaches get `SIGTERM`, then `SIGKILL` after 2 s or
immediately past 1.25× the ceiling. Diagnostics use `last-run.json` and
`history.jsonl` under the machine state directory's `journal/` subdirectory,
keyed by repository identity so every worktree of a clone shares one journal;
nothing is ever written into the checkout (#239). `rss-limit` and `timeout`
exit non-zero.

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

## Deployment status

The guard shipped fleet-wide through the harness sync while ENG-0138 was still
Proposed, and #331 retracted it: the files moved to the retired-path inventory,
so the next sync deletes the consumer copies, and the harness adapters
(`.claude/settings.json`, `.codex/hooks.json`, `.cursor/hooks.json`,
`.github/hooks/agent-guard.json`, `.windsurf/hooks.json`) no longer register
the hook anywhere. The implementation and its conformance test stay in this
repository; if ENG-0138 is ever accepted, distribution is a new decision to
take then, not a default to restore.

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
