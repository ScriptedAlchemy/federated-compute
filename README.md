# federated-compute

Experimental: **Module Federation–flavored [Machinen](https://machinen.dev)**.

The consumer imports functions like any federated module — but the "remote" is
actually a machine. A custom Module Federation runtime plugin claims machine
entries, attaches (or boots) through a driver, and returns a virtual container
whose exports are typed async function bindings. Every call is translated into
an RPC into the machine. Bindgen for machines: it feels like one app, but the
work runs somewhere else — in any language.

**Containment is the rule:** every machine is its own repo/deployment. The
host never references machine source — federation entries are the multiplexer
and the transport.

```ts
const plugin = machinenPlugin({
  driver: httpAttachDriver(),
  restartOnCrash: true,
  calls: { timeoutMs: 10_000, retries: 2, circuitBreaker: { threshold: 5, resetMs: 10_000 } },
});

const host = createInstance({
  name: 'host',
  remotes: [
    // attach to an independently deployed machine — address + required version
    { name: 'java_machine', entry: 'machinen+http://127.0.0.1:3802?version=^1.0.0&token=...' },
    // or boot one from an image (driver owns the transport)
    { name: 'compute_machine', entry: 'machinen://images/compute.tar.gz?version=^1.0.0' },
  ],
  plugins: [plugin],
});

host.registerRemotes([...]); // machines can join dynamically, standard MF API
await plugin.warm();         // preloadRemote analog: attach + validate before traffic

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
| DTS type distribution | `machinen-bindgen --url <machine> --out types.ts` pulls types from deployed machines |
| retry plugin / `errorLoadRemote` | call policy: deadlines, transport-only retries, circuit breaker, crash restart |

## How it works

- The plugin implements the MF runtime's [`loadEntry` hook](https://module-federation.io/guide/runtime/runtime-plugins) —
  the documented extension point for new remote loading strategies. Machine
  entries never resolve to JS; the plugin resolves the machine, fetches its
  typed manifest, negotiates versions, and synthesizes a container of function
  proxies governed by the call policy.
- Machines speak the [guest protocol v3](docs/guest-protocol.md):
  `GET /mf-manifest.json`, `GET /mf/health`, `POST /mf/call` — typed
  signatures, bearer-token auth, NDJSON streaming, structured error envelopes,
  body caps, graceful shutdown. Any language qualifies: `apps/remote` (Node),
  `apps/remote-java` (Java 21, zero deps), `apps/remote-python` (Python 3,
  stdlib only).
- **Bindgen**: `pnpm bindgen` (or the `machinen-bindgen` CLI against any
  deployed machine URL) generates host-side TypeScript interfaces
  (`apps/host/src/generated/`), so `loadRemote<T>` types come from the
  machines themselves.
- **Observability**: `plugin.metrics()` reports per-machine calls, errors,
  crashes, retries, timeouts, circuit opens, and p50/p95 latency — all fed by
  the hook system, so external telemetry can tap the same hooks.
- Machine access is a `MachineDriver`:
  - `httpAttachDriver()` — attach to a deployed machine (`machinen+http://...`),
    the containment-preserving default.
  - `processDriver()` — boot an image as a local child process (stand-in for
    `@machinen/runtime`'s `boot()` until its source is public). Allocates ports,
    injects auth tokens, picks the boot command by image type (`.js` → node,
    `.java` → java source mode, `.jar` → `java -jar`, `.py` → python3, extensible).
  - `inProcessDriver()` — same-process guest, used by tests.
  - A real `MachinenDriver` (provision/boot/snapshot/restore over microVMs)
    slots behind the same interface later.

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
driver's handle, so a real microVM driver gets them for free.

## Layout

```
packages/runtime-plugin   @federated-compute/machinen-plugin (plugin, hooks, drivers, guest runtime, bindgen)
apps/remote               machine: Node guest (Rsbuild, node target)
apps/remote-java          machine: Java 21 guest (single file, zero deps)
apps/remote-python        machine: Python 3 guest (single file, stdlib only)
apps/host                 consumer: attaches to all machines by address only
scripts/                  dev orchestrator (stands in for per-machine deployments)
docs/guest-protocol.md    the wire protocol any guest language implements
```

## Run it

```bash
pnpm install
pnpm test         # unit tests + cross-language conformance suite
pnpm -r build
pnpm demo         # boots all machines as separate services, runs the host
pnpm bindgen      # regenerate typed bindings from machine manifests
```

Requires Node 22+, a JDK 21+ for the Java machine, and Python 3 for the
Python machine. CI runs the full suite plus the end-to-end demo.

## Status

Experimental. The Machinen runtime source isn't public yet; the process driver
simulates the boot/port-forward model and the attach driver covers deployed
machines, so the binding layer is real today and the VM layer swaps in later.
