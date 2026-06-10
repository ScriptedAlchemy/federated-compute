# Operators guide

This doc is for the people who wire machines up and keep them healthy: it
covers the operator API, call policy, runtime hooks, snapshot/restore,
the demos, data gravity, and `machinen.config.json`. End users consuming
machines as imports only need the [README](../README.md).

## The operator API

```ts
import { createMachines } from '@federated-compute/machinen-plugin/client';

const machines = createMachines({
  remotes: { java_machine: 'machinen+http://127.0.0.1:3802' },
  calls: { timeoutMs: 10_000, retries: 2, circuitBreaker: { threshold: 5, resetMs: 10_000 } },
});
await machines.warm();                         // preloadRemote analog
machines.plugin.machineHooks.beforeCall.on(...); // full hook surface
machines.metrics();                            // p50/p95, errors, crashes...
```

`configureMachines(options)` is the set-once global variant: it configures
the default client that generated bindings use, and must run before any
machine call.

The raw MF runtime style (`createInstance` + `machinenPlugin` + `loadRemote`)
keeps working underneath:

```ts
const host = createInstance({
  name: 'host',
  remotes: [
    // attach to an independently deployed machine — address + required version
    { name: 'java_machine', entry: 'machinen+http://127.0.0.1:3802?version=^1.0.0&token=...' },
    // or boot one from an image (driver owns the transport)
    { name: 'compute_machine', entry: 'machinen://images/compute.tar.gz?version=^1.0.0' },
  ],
  plugins: [machinenPlugin({ driver: httpAttachDriver() })],
});

// Types come from the machine's manifest via bindgen — not hand-written.
const math = await host.loadRemote<ComputeMachineModules['./math']>('compute_machine/math');
await math.add(20, 22);                       // unary call into the machine
for await (const n of math.countdown(3)) ...  // streaming call (NDJSON under the hood)
```

## How it follows Module Federation

| MF concept | Machine analog |
| --- | --- |
| `mf-manifest.json` | `GET /mf-manifest.json` — typed manifest with `version`, `metaData`, `exposes` |
| `requiredVersion` negotiation | entry `?version=^1.0.0` validated against the machine manifest (semver) |
| runtime `loadEntry` plugin hook | claims machine entries, synthesizes virtual containers of function proxies |
| `registerRemotes` / dynamic remotes | machines join at runtime through the same API |
| `preloadRemote` | `plugin.warm()` pre-attaches and validates machines before traffic |
| DTS type distribution (`@mf-types`) | machines publish `GET /mf-types.ts`; host bindgen pulls from deployed URLs only |
| retry plugin / `errorLoadRemote` | call policy: deadlines, transport-only retries, circuit breaker, crash restart |

## How it works

- The plugin implements the MF runtime's [`loadEntry` hook](https://module-federation.io/guide/runtime/runtime-plugins) —
  the documented extension point for new remote loading strategies. Machine
  entries never resolve to JS; the plugin resolves the machine, fetches its
  typed manifest, negotiates versions, and synthesizes a container of function
  proxies governed by the call policy.
- Machines speak the [guest protocol v3](guest-protocol.md):
  `GET /mf-manifest.json`, `GET /mf/health`, `POST /mf/call` — typed
  signatures, bearer-token auth, NDJSON streaming, structured error envelopes,
  body caps, graceful shutdown. Any language qualifies: `apps/remote` (Node),
  `apps/remote-java` (Java 21, zero deps), `apps/remote-python` (Python 3,
  stdlib only).
- **Bindgen is containment-preserving**, like MF's `@mf-types` flow: each
  machine distributes its own types — the guest serves `GET /mf-types.ts`
  generated from its own manifest (or a machine's CI publishes it statically),
  and machines without TS codegen are covered because the manifest itself
  carries full signatures. The host's `pnpm --filter host bindgen` pulls
  bindings purely over the network from the deployed machine URLs in its own
  config (`MACHINEN_REMOTE_*`) — it never reads another repo's source or
  disk. Generated modules land in `apps/host/src/generated/` as
  ready-to-import lazy bindings, so user code never touches `loadRemote`.
- **Observability**: `plugin.metrics()` reports per-machine calls, errors,
  crashes, retries, timeouts, circuit opens, and p50/p95 latency — all fed by
  the hook system, so external telemetry can tap the same hooks.
- Machine access is a `MachineDriver`:
  - `httpAttachDriver()` — attach to a deployed machine (`machinen+http://...`),
    the containment-preserving default.
  - `processDriver()` — boot an image as a local child process: the lightweight
    local driver for dev and tests (no VMs, instant boots, app-state `.snap`
    bundles). Allocates ports, injects auth tokens, picks the boot command by
    image type (`.js` → node, `.java` → java source mode, `.jar` → `java -jar`,
    `.py` → python3, extensible).
  - `inProcessDriver()` — same-process guest, used by tests.
  - `machinenDriver()` — the real thing: boots `machinen://` entries as
    actual microVMs via `@machinen/runtime` (KVM/HVF), with whole-VM
    snapshot/restore. See [Real Machinen driver](machinen-driver.md).

## Custom runtime hooks

`@module-federation/runtime-core` doesn't export its hook classes (as of
2.5.1), so the plugin owns a machine lifecycle hook system with the same
tap-and-emit shape:

| Hook | Fires |
| --- | --- |
| `beforeMachineBoot` / `onMachineReady` | machine lifecycle |
| `beforeCall` / `afterCall` | around every call; `beforeCall` may rewrite args |
| `onMachineError` | the guest threw (surfaced as `GuestError` with remote type/stack) |
| `onMachineCrash` | machine unreachable after retries; with `restartOnCrash` the plugin reboots + retries once |
| `onCircuitOpen` / `onCircuitClose` | circuit breaker state changes |
| `beforeSnapshot` / `onSnapshotted` | around `plugin.snapshotMachine(name)` |
| `beforeFork` / `onForked` | around `plugin.forkMachine(name)` |

Snapshot/fork mirror Machinen's signature operations and delegate to the
driver's handle: the process driver freezes app state into `.snap` bundles,
`machinenDriver()` dumps the whole microVM.

## Boot once, run everywhere

Two scenarios, both through federation (`pnpm demo:snapshot`):

1. **Cold boot**: entries point at images (`machinen://app.py`); loading the
   remote boots the machine from scratch.
2. **Unfreeze**: a warm machine is frozen with `plugin.snapshotMachine(name)`
   into a `.snap` bundle (state + image reference, like Machinen bundles
   remembering their rootfs tarball). A different host points its entry at the
   snapshot (`machinen://machine.snap`) — **loading the remote restores the
   machine**, which continues exactly where it left off (the demo proves it
   with counters that survive the move across all three languages).

The same story runs at two depths:

- **App-state snapshots** (process driver): guests opt in via the protocol's
  `state` capability (`GET/POST /mf/state`); `.snap` bundles are tiny
  (~190 bytes for the demo counters) and freeze/restore is effectively
  instant — ideal for dev loops and CI.
- **Whole-VM snapshots** (`machinenDriver()`): the same `MachineDriver`
  interface dumps the entire microVM — RAM, rootdisk, vCPU state, ~2.5GB,
  ~7s — with **zero guest cooperation**: no `/mf/state`, the heap simply
  survives (`pnpm demo:machinen`).

## Interactive demo

`pnpm demo:web` serves a dashboard (http://localhost:3800) backed by a host
API whose handlers are plain binding calls — the real-world shape: browser ->
host backend -> machines loaded on demand. It shows machines flipping from
cold to warm on first use, a polyglot pipeline (one request fanning out to
JVM hashing, CPython analysis, and Node transforms), per-machine counters
proving state lives inside each machine, a countdown streamed machine ->
host (NDJSON) -> browser (SSE), and a live activity log fed by the runtime
plugin's hooks.

## Data gravity (move the code to the data)

The second page (http://localhost:3800/gravity, or `pnpm demo:gravity` for
the CLI) demonstrates why machine mobility matters. A database machine lives
in a far region behind a simulated WAN link (adjustable latency). A "top
spenders" report needs 1 + N queries:

- **Cross-region**: the consumer runs the N+1 itself — every query crosses
  the WAN. 25 queries x 75ms ≈ 2 seconds.
- **Co-located**: one federated call to `analytics_machine` — the code that
  moved to the data region — which runs the same N+1 over same-region hops
  and is itself a machine consuming `db_machine` through federation bindings
  (machine-to-machine federation). 1 crossing ≈ 200ms, ~10-20x faster.

The consumer's code is import-shaped either way; only the federation entries
(addresses) differ. And "moving the code" as a snapshot restored next to the
data is implemented, not hypothetical: `machinenDriver()` freezes a running
microVM and a `machinen://<snapDir>` entry restores it anywhere
(`pnpm demo:machinen`) — the topology change needs no code change.

## machinen.config.json

A consumer app declares its machines once, in a `machinen.config.json` that
lives in the app (e.g. `apps/host/machinen.config.json`) and is found by
walking up from the working directory:

```json
{
  "machines": {
    "compute_machine": { "url": "machinen+http://127.0.0.1:3801", "version": "^1.0.0" },
    "java_machine": { "url": "machinen+http://127.0.0.1:3802", "version": "^1.0.0" }
  },
  "bindgen": { "outDir": "src/generated" }
}
```

- `machines.<name>.url` accepts the same entry forms the runtime does
  (`machinen+http://...` to attach, `machinen://...` to boot an image);
  `version` is an optional semver range (the MF `requiredVersion` analog).
- `bindgen.outDir` is where generated bindings land, relative to the config
  file. Default: `src/generated`.
- `index` is a **reserved machine name** — the barrel is written as
  `<outDir>/index.ts`, so a machine called `index` would collide with it.

**Address resolution precedence** in `createMachines()` / `getMachines()`:
explicit options (`remotes`) > `MACHINEN_REMOTE_<NAME>` env var > config
file. The config holds dev defaults; env vars are how production overrides
them per environment without touching code or config.

**Version pin precedence**: an explicit `?version=` on the entry >
`options.versions` > the per-module pin baked into generated bindings > the
config file's `version`.

`machinen-bindgen` (the `pnpm --filter host bindgen` underneath) uses the
same config:

- **No arguments**: regenerates one binding file per machine in
  `bindgen.outDir`, plus an `index.ts` barrel (a namespace export per machine
  and flat re-exports for names that are unambiguous across machines).
- `--check`: diffs against disk and exits 1 on drift without writing — the
  CI gate (`node scripts/bindgen.mjs --check` in this repo).
- `--url <machine-url> --out <file.ts>`: ad hoc single-machine mode, no
  config needed.

## What is this for? (extended)

Module Federation solved "many teams, one web app" by making deployed JS
composable at runtime. Point the same machinery at *processes* instead of
bundles and a lot of distributed-systems pain becomes a config change:

**Erase the SDK industry.** Every cross-language service today ships client
libraries: a Java SDK, a Python SDK, a Node SDK, docs for each, version
matrices for all. Here, a service publishes one typed manifest and every
consumer imports functions — `await strings.sha256(x)` — with types pulled
from the machine itself. The contract isn't a wiki page; it's the manifest,
enforced by a conformance suite any language can run. Internal platform
teams stop writing clients and start publishing machines.

**Respect data gravity.** The `/gravity` demo in miniature: don't drag
gigabytes across regions to run a loop — restore the loop next to the data.
Same trick solves data residency: an EU tenant's processing machine restores
inside the EU; results cross the border, raw data never does. Air-gapped and
compliance enclaves work the same way — code goes in, answers come out.

**Kill the cold start.** A JVM that took 40 seconds to warm up, an ML model
that took minutes to load weights into a GPU — snapshot them *warm*. Scale
from zero by restoring, not booting. It's serverless where the function
keeps its heap: caches hot, connections open, JIT already done.

**Fork reality.** A machine mid-task can be forked: run an AI coding agent
to a decision point, fork it five ways, race five approaches, keep the
winner. Fork the production-state machine to rehearse a risky migration on
real state, then throw the copy away. Spin per-PR preview environments from
one warm staging snapshot instead of rebuilding the world per branch.

**Ship the running process.** Machinen's founding pitch: your agent is
mid-task and your battery is dying — freeze, move to the desktop, resume.
The same move debugs production: snapshot the misbehaving machine and
restore it on a laptop with a debugger attached, heap and all.
"Works on my machine" becomes a deployment strategy.

**Wrap the unwrappable.** That load-bearing Java 8 service nobody dares
touch, the Fortran solver, the vendor binary: put a thin guest in front and
it becomes typed imports with semver negotiation — a strangler-fig migration
where consumers never feel the strangling. Vendors could ship a machine
image instead of maintaining SDKs in six languages.

**Operate it like MF.** Everything MF taught the frontend works here:
dynamic remotes (machines join at runtime), version pinning
(`?version=^2.0.0` rejects incompatible machines at attach), circuit
breakers and crash-restart per machine, p50/p95 metrics from the hook
system. Region failover is changing an address. A canary is registering a
second machine and shifting traffic between entries.

The demos in this repo are each one of these stories made small: the
dashboard is the no-SDK story, `/gravity` is the data-gravity story, and
`demo:snapshot` is the cold-start/fork story.
