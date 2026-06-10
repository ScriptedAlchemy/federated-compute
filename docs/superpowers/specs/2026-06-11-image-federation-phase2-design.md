# Design: image/vmstate federation Phase 2 — whole-VM pull and restore

Date: 2026-06-11
Status: Design only

## Executive summary

Phase 2 should make a running microVM's **whole VM state** a federated artifact:
RAM, rootdisk, vCPU state, and the small restore metadata needed to bring the
guest protocol back online somewhere else. This is the Machinen version of
Module Federation loading `remoteEntry.js`, except the artifact is a paused
process image rather than executable source. Pulling it means "ship the running
process": fetch a digest-pinned vmstate bundle, materialize it in the local
cache, restore it through `machinenDriver()`, and bind the same exposed
functions the host already knows how to call.

The recommended architecture is **host-owned publication through a machine
registry sidecar**, backed by a content-addressed HTTP layout that can be served
by a dumb file server or CDN once a bundle is published. A VM guest cannot dump
its own VM; only the host that owns the VMM can call `handle.snapshot()`.
Trying to force this through `/mf-snapshot` inside the guest would hide the
most important asymmetry in the system. Phase 2 should embrace the asymmetry:
guests keep serving protocol, calls, types, and Phase 1 app-state artifacts;
the host sidecar serves whole-VM artifacts.

The smallest credible increment, **Phase 2a**, is explicit publish and pull:
boot a VM, call `snapshotMachine()`, publish the resulting snapshot directory
into a local registry layout, serve it over HTTP with `Range` support, resolve
`machinen+pull+http://...?artifact=vmstate`, restore it elsewhere, and prove
the counter continues. Streaming resume, automated GC, and fork-by-pull
ergonomics can follow after the end-to-end shape is true.

Top design risks:

1. **Compatibility is stricter than the current manifest can express.**
   vmstate is bound to architecture, Machinen/runtime version, vmstate format,
   memory layout, base assets, and the reseed behavior. The resolver must fail
   before downloading gigabytes when any of those do not match.
2. **Publishing vmstate publishes memory.** This repo intentionally has no auth,
   but vmstate bundles contain code, heap, secrets, open-file contents, and
   maybe credentials. Phase 2 stays authless for repo scope, with digests for
   integrity, while making the future auth insertion points explicit.
3. **The economics only work in specific cases.** A 2.5GB cold pull over 1Gbps
   is slower than a fresh boot unless the bundle is already near the consumer or
   the warm state is expensive enough to justify the transfer.

## MF grounding

Phase 1 completed the missing `remoteEntry.js` leg for small artifacts:

- `mf-manifest.json` maps to `GET /mf-manifest.json`.
- `@mf-types` maps to `GET /mf-types.ts`.
- `remoteEntry.js` maps to `artifacts.image` and, for app-level warm state,
  `artifacts.snapshot`.
- MF's share scope maps to a digest-addressed artifact cache.
- MF's `requiredVersion` maps to entry `?version=` checked before artifact
  download and again after boot.

Phase 2 keeps the same model and adds a Machinen-only artifact with no direct MF
analog: `artifacts.vmstate`. It is still a manifest-discovered artifact loaded
by the runtime's `loadEntry` hook, but the "script loader" is
`machinenDriver().boot()` restoring a snapshot directory instead of a browser
executing JavaScript.

That matters for the API boundary. In MF, a remote deploy can serve its own
`remoteEntry.js` because the artifact is just a file in the deploy. In Phase 1,
a guest can serve `/mf-image` and `/mf-snapshot` because those artifacts are
inside the guest's application authority. In Phase 2, a guest cannot serve
vmstate: the guest is inside the state being captured. The artifact publisher is
the host that owns the VMM.

## Current implementation surfaces

The Phase 1 branch already has the right consumer-side insertion point:

- `parseMachineEntry()` recognizes `machinen+pull+http(s)://` entries before
  generic attach entries.
- `resolvePullEntry()` fetches the origin manifest, checks `?version=` before
  bytes move, selects `?artifact=image|snapshot`, verifies sha256 digests, uses
  a content-addressed cache, and rewrites the spec to `kind: "image"`.
- `machinenPlugin()` resolves pull entries before `driver.boot()`, memoizes the
  result per original entry, and emits artifact hooks.
- `machinenDriver()` already restores `machinen://<snapDir>` when the path is a
  directory with `meta.json` and `state.vmstate`.
- `snapshotMachine()` calls `handle.snapshot()`, and the machinen handle writes
  a snapshot directory plus `federated-machine.json` with guest-port metadata.

Phase 2 should extend these surfaces rather than introduce a new driver
interface. The consumer resolver should learn one more artifact format,
materialize a local snapshot directory, then hand the existing machinen driver a
normal `machinen://<local-snapDir>` boot.

## Artifact shape

### Manifest addition

Extend `MachineExposeManifest.artifacts` with `vmstate`:

```json
{
  "name": "compute_machine",
  "protocol": 3,
  "version": "1.2.0",
  "artifacts": {
    "vmstate": {
      "href": "vmstate/sha256-8c0d.../bundle.json",
      "format": "machinen-vmstate@1",
      "digest": "sha256:8c0d...",
      "bytes": 2684354560,
      "platform": "linux/amd64",
      "mediaType": "application/vnd.federated-compute.machinen-vmstate.manifest+json",
      "compatibility": {
        "machinenRuntime": "0.4.0",
        "vmstateFormat": "machinen-vmstate@1",
        "snapshotEngine": "machinen-default",
        "guestMemoryMiB": 2048,
        "reseed": "machinen-0.4.0-shim@1"
      }
    }
  },
  "exposes": {}
}
```

`artifacts.vmstate.href` points to a small bundle manifest, not directly to a
2.5GB tarball. The descriptor's `digest` is the bundle digest: sha256 over the
canonical JSON bundle manifest. That gives users a single pin for entries
(`?digest=sha256:...`) while still letting the transfer happen per file.

Phase 2 should canonicalize platform values to OCI-style names
(`linux/amd64`, `linux/arm64`, `darwin/arm64`) and map Node's `process.arch`
values (`x64`, `arm64`) at the resolver boundary. The current Phase 1 resolver
uses Node-style `process.platform/process.arch`; vmstate needs a stable wire
vocabulary because registries and CI summaries will outlive one Node process.

### Bundle manifest

The bundle manifest is the restore plan:

```json
{
  "format": "machinen-vmstate@1",
  "name": "compute_machine",
  "createdAt": "2026-06-11T00:00:00.000Z",
  "source": {
    "manifestVersion": "1.2.0",
    "remoteName": "compute_machine"
  },
  "compatibility": {
    "platform": "linux/amd64",
    "machinenRuntime": "0.4.0",
    "vmstateFormat": "machinen-vmstate@1",
    "snapshotEngine": "machinen-default",
    "guestMemoryMiB": 2048,
    "guestPort": 3801,
    "reseed": "machinen-0.4.0-shim@1"
  },
  "files": [
    {
      "path": "meta.json",
      "href": "../../blobs/sha256/1111...",
      "digest": "sha256:1111...",
      "bytes": 2048,
      "role": "machinen-meta",
      "compression": "none"
    },
    {
      "path": "state.vmstate",
      "href": "../../blobs/sha256/2222...",
      "digest": "sha256:2222...",
      "bytes": 2684350000,
      "role": "machinen-vmstate",
      "compression": "none"
    },
    {
      "path": "federated-machine.json",
      "href": "../../blobs/sha256/3333...",
      "digest": "sha256:3333...",
      "bytes": 256,
      "role": "federated-marker",
      "compression": "none"
    }
  ]
}
```

The resolver downloads the manifest first, validates every compatibility field,
then downloads each file into `.machinen/cache/blobs/sha256/<hex>`. It
materializes the snapshot directory as links or copies:

```text
.machinen/cache/vmstate/sha256-8c0d.../
  meta.json
  state.vmstate
  federated-machine.json
```

The materialized directory is what `machinenDriver()` already understands.

### Per-file versus per-bundle content addressing

Use **both**:

- The bundle digest is the user-facing identity and entry pin.
- Each file digest is the transfer, integrity, dedupe, and resume identity.

A single tarball digest is simple but bad for multi-GB vmstate: one interrupted
download restarts the whole thing, registries cannot dedupe metadata versus
state, and later delta/layer work has nowhere to attach. Per-file digests let
the cache share identical `meta.json`, marker files, and future rootfs/kernel
assets across bundles. The bundle digest still prevents manifest substitution:
if any file descriptor changes, the canonical bundle JSON hash changes.

### Compression

Do not use transparent HTTP compression for vmstate. It hides the byte stream
that the digest covers, makes resume harder, and leaves too much behavior to
proxies. Compression should be an explicit file property:

- Phase 2a: `compression: "none"` only. Prove restore semantics first.
- Phase 2b: allow `zstd` for files published offline or by the sidecar, with
  digests over the stored compressed bytes and a second `uncompressedDigest`
  only if restore needs it.

The honest default is uncompressed. `state.vmstate` may contain pages that
compress well, but compression spends CPU on the producer during an already
expensive snapshot and on the consumer before restore. It is worth testing, not
assuming.

## Transport

Phase 1's resolver reads small artifacts into memory. Phase 2 must stream to
disk:

- `GET bundle.json` is small and can be buffered.
- Blob downloads use `Range` and `If-Range` with `ETag` or digest-derived
  immutable URLs.
- Partial files live as `.partial` beside the destination, with a recorded byte
  count and expected digest.
- On restart, the resolver resumes with `Range: bytes=<current>-` when the
  server supports it; otherwise it restarts the blob.
- A completed blob is verified by sha256 before it is moved into the blob cache.
- The materialized snapshot directory is only published locally after every file
  verifies.

A "dumb HTTP directory" can satisfy this if it serves static files, stable
headers, and byte ranges. For Phase 2a, even a simple Node static server is
enough. For production-like use, nginx, object storage, or a CDN is the right
shape; the smart part is the publisher, not the file server.

The resolver should emit progress through a new hook shape rather than burying
it in logs:

- `beforeArtifactFetch` remains the start event.
- `onArtifactProgress` reports blob digest, bytes complete, total bytes, and
  whether the bytes came from cache or network.
- `onArtifactFetched` remains the terminal event with local path, duration, and
  cache hit summary.

## Producing vmstate from a running VM

### The guest does not serve vmstate

The guest process inside the VM cannot call `handle.snapshot()` because the
handle belongs to the host-side driver. It also cannot safely stream the
resulting `state.vmstate` while being frozen by the snapshot operation. Phase 2
should not add `/mf-vmstate` to `serveGuest()`.

Instead, introduce a host-side **machine registry sidecar**. It runs next to the
host process that called `createMachines({ driver: machinenDriver() })`, has
access to that plugin instance, and owns three responsibilities:

1. Resolve the live machine by name.
2. Trigger `plugin.snapshotMachine(name)` on explicit request or schedule.
3. Publish the resulting snapshot directory into a registry layout and serve the
   manifest plus blobs.

This can be a small package-level helper rather than a new service framework:
`serveMachineRegistry({ machines, publishDir, hostname, port })`.

### Trigger semantics

Snapshotting is a side effect measured in seconds and gigabytes, so **GET should
not create a new vmstate bundle**. The sidecar should expose explicit publish
operations:

- `POST /machines/:name/vmstate` creates a new snapshot and returns `202` with
  an operation URL, or blocks and returns `201` for the first simple version.
- `GET /machines/:name/mf-manifest.json` returns the machine manifest with the
  latest published `artifacts.vmstate`, if one exists.
- `GET /machines/:name/vmstate/<bundle>/bundle.json` returns the bundle
  manifest.
- `GET /machines/:name/blobs/sha256/<hex>` returns blob bytes with `Range`
  support.

For compatibility with Phase 1's machine-scoped URL style, the sidecar can also
mount one machine at a base URL:

```text
GET /mf-manifest.json
GET /vmstate/sha256-.../bundle.json
GET /blobs/sha256/<hex>
```

This keeps `machinen+pull+http://host:port/machines/compute?artifact=vmstate`
and `machinen+pull+http://host:port?artifact=vmstate` both possible without a
new entry grammar.

### Quiesce semantics

The Phase 2 default is **VM-consistent, not application-drained**:

- The sidecar calls `handle.snapshot()`.
- `machinenDriver()` writes the reseed shim, asks the runtime to snapshot
  through an attach handle, and the VMM freezes state.
- The guest resumes on the source host after the dump completes.
- A restored clone resumes from the snapshot point with a new port forward and
  new host-side network identity.

This is stronger than Phase 1 app-state snapshots because it captures heap,
kernel state, timers, file descriptors, and rootdisk. It is not a distributed
transaction. In-flight requests, external database connections, leases, and
identity-bearing sockets need application policy. The sidecar should offer
optional pre/post hooks later (`beforeVmstateSnapshot`, `afterVmstateSnapshot`),
but Phase 2a should document the default and keep the implementation honest.

### Where bundles land

`machinenDriver()` already writes raw snapshots to `.machinen/vm-snapshots` by
default. The sidecar should copy or hardlink those files into a publication
store:

```text
.machinen/registry/
  machines/
    compute_machine/
      mf-manifest.json
      index.json
      vmstate/
        sha256-8c0d.../
          bundle.json
      blobs/
        sha256/
          1111...
          2222...
          3333...
```

`index.json` is a convenience listing for operators and demos, not part of the
resolver contract. The resolver needs only the machine manifest and the bundle
manifest.

### Garbage collection

There are two independent GC domains:

- **Producer registry GC:** delete unpublished raw snapshot dirs after publish,
  keep the latest N bundles or bundles younger than a TTL, and never remove a
  blob still referenced by a retained bundle manifest.
- **Consumer cache GC:** delete unreferenced blob files and materialized snapshot
  dirs by LRU or max bytes, but never while a machine restored from that
  materialized dir is still live.

Phase 2a can use explicit cleanup commands and temp dirs. Phase 2c should add
policy knobs (`maxBundles`, `maxBytes`, `ttlMs`) and a mark-and-sweep pass over
bundle manifests.

## Registry topology

### Options

**Direct peer pull** is attractive for demos: the source host snapshots and the
consumer downloads from it. It has the fewest moving parts, but it couples
source VM health to download traffic, repeats 2.5GB transfers per consumer, and
turns every producer into a CDN.

**Registry/cache tier** is the CDN analog. A host publishes once, consumers pull
from a nearby cache, and the registry can enforce retention, serve ranges well,
and eventually sit behind real auth. It is the right production topology.

**Host-side shared cache** is the share-scope analog on each consumer. It does
not replace a registry; it prevents repeated downloads and lets multiple
machines or restored clones share blobs by digest on the same host.

### Recommendation

Build Phase 2 around a **host-side machine registry sidecar that publishes to a
dumb HTTP-compatible content store**, plus the existing consumer cache extended
for large blobs. This gives the demo a direct peer path and gives production a
CDN path without changing the resolver:

```text
source host             registry/cache                 consumer host
-----------             --------------                 -------------
running VM
  |
sidecar POST snapshot
  |
handle.snapshot()
  |
publish bundle  --->  static HTTP / object store  --->  resolvePullEntry()
                                                        blob cache
                                                        machinenDriver.restore()
```

The registry API should be deliberately boring:

- `GET /mf-manifest.json` or `GET /machines/:name/mf-manifest.json`
- `GET /vmstate/:bundle/bundle.json`
- `GET /blobs/sha256/:hex`
- Optional producer-only `POST /machines/:name/vmstate`

No OCI registry dependency is needed for Phase 2. The layout is OCI-like in the
useful parts: content-addressed blobs, a small manifest that names blobs, and
immutable digests. Adopting full OCI Distribution API now would add auth,
uploads, tags, and media-type machinery before the restore path is proven.

## Version and platform negotiation

Phase 1's `?version=` check protects the guest API surface. Phase 2 needs a
second required-version analog for hardware and runtime compatibility. The
resolver should validate this before downloading blobs:

- Machine API version: `manifest.version` satisfies entry `?version=`.
- Artifact format: descriptor and bundle `format` are exactly
  `machinen-vmstate@1`.
- Platform: descriptor and bundle platform equal the normalized host platform.
- Machinen runtime: bundle `compatibility.machinenRuntime` is compatible with
  the installed `@machinen/runtime`. For Phase 2a, require exact `0.4.0`.
- Snapshot engine: known engine value; reject unknown engines.
- Guest memory/layout: restore should not override memory; bundle dictates it.
  Metadata is for diagnostics and preflight errors.
- Reseed: bundle records that the functional reseed shim was present before
  dump, or that the runtime version has a fixed upstream reseed helper.

Error messages should read like dependency negotiation failures, not VMM crashes:

```text
[machinen-plugin] pull "compute_machine": vmstate platform mismatch before
download: artifact requires linux/amd64, this host is linux/arm64
```

```text
[machinen-plugin] pull "compute_machine": vmstate requires
@machinen/runtime 0.4.0, installed 0.5.1; refuse to restore an incompatible
bundle
```

Reseed deserves explicit treatment. Whole-VM bundles freeze kernel CSPRNG state.
On amd64 machinen 0.4.0, this branch fixes restore by replacing the broken
helper with a shim that credits a host-provided seed and forces a crng rekey.
When bundles are shared between hosts, the consumer must preserve that property:
two restores from one bundle must produce different entropy immediately. The
bundle manifest should record the reseed mechanism, and the real-VM e2e should
keep asserting entropy divergence across two restores.

## Integrity and auth stance

The repo deliberately has no auth. Phase 2 should keep that scope:

- No tokens, OAuth, mTLS, ACL system, signed URLs, or registry identity in the
  design to be implemented now.
- Bind sidecars and guests to loopback by default.
- Treat exposing a sidecar beyond loopback as an operator decision.

Integrity is in scope:

- Every bundle and blob is sha256-addressed.
- Entry `?digest=sha256:...` pins the bundle digest.
- The resolver verifies bundle digest, each blob digest, and the materialized
  file set before restore.
- Digest mismatches fail closed and cache nothing.

Auth slots for real deployments are obvious and should not disturb the design:
an HTTP middleware in front of the sidecar, CDN/object-store auth on blob URLs,
signed manifests, or mTLS between hosts. Those layers decide who may read a
bundle; the Phase 2 resolver decides whether the bytes are the advertised bytes.

## Driver integration

### Consumer side

Extend the existing pull resolver:

- Add `PullArtifactKind = "image" | "snapshot" | "vmstate"`.
- Add `artifacts.vmstate?: ArtifactDescriptor`.
- `?artifact=vmstate` selects `machinen-vmstate@1`.
- Fetch and verify the bundle manifest.
- Validate compatibility before any blob download.
- Stream blobs into `.machinen/cache/blobs/sha256/<hex>`.
- Materialize a snapshot directory under `.machinen/cache/vmstate/<bundle>`.
- Rewrite the spec to `kind: "image", image: <materializedSnapDir>`.

No new `MachineDriver` method is needed. `machinenDriver().boot()` already sees
a local snapshot dir and calls restore. `processDriver()` and `httpAttachDriver()`
will reject the rewritten spec naturally if they cannot boot it; the user-facing
docs should say vmstate pulls require `machinenDriver()`.

The current `bootTimeoutMs` includes artifact fetch time. For Phase 2, that is
too blunt: a 2.5GB pull may legitimately exceed a normal boot timeout. Add a
separate `artifactFetchTimeoutMs` or document that Phase 2 callers must raise
`bootTimeoutMs` until the timeout split lands. The design preference is a split,
because restore timeout and network timeout are different failure domains.

### Producer side

Add a host-side sidecar rather than changing `serveGuest()`:

```ts
serveMachineRegistry({
  machines,
  publishDir: ".machinen/registry",
  remotes: ["compute_machine"],
  hostname: "127.0.0.1",
  port: 0
});
```

The sidecar can be implemented in this package because it needs plugin access,
not guest access. It asks the plugin for the live machine, triggers
`snapshotMachine()`, reads the returned `{ snapDir, image }`, builds a bundle
manifest, and serves registry files. If a VM was produced outside this plugin,
the sidecar can also publish an existing snapshot directory as a static bundle,
which is the best 2a path.

### Manifest source of truth

The sidecar should serve the guest's normal manifest with only one additive
change: `artifacts.vmstate`. It can obtain the base manifest from the live
handle or from the plugin's cached boot result. It must not invent `exposes`,
`version`, or `metaData`; those remain guest-owned. This keeps bindgen, version
checks, and call binding aligned with the running VM.

## Fork story

Native `fork()` is not the portable Phase 2 semantic. On amd64 machinen 0.4.0 it
is explicitly unreliable and the driver throws a clear error. The portable
semantic is **fork-by-pull**:

1. Snapshot the source VM once.
2. Publish the bundle.
3. Restore it twice, either on the same host or different hosts.
4. Each restored VM gets its own host-side port forward and diverges from the
   shared snapshot point.

When upstream `fork()` becomes reliable, it can be an optimization for local
same-host clones: if the source and target are on the same host and the runtime
supports native fork, use it. Across hosts and registries, snapshot plus restore
remains the semantic because it is observable, cacheable, and works over HTTP.

The user-facing rule should be blunt:

- Use **attach** for state you intend to share.
- Use **pull image** for code you want to own locally.
- Use **pull vmstate** for warm state you want to own locally and diverge from.

## Testing and CI strategy

### Testable without KVM

Most resolver and registry behavior can be tested with fake bundles:

- `parseMachineEntry()` accepts `?artifact=vmstate` without a new grammar.
- Manifest schema accepts `artifacts.vmstate`.
- Resolver rejects missing `vmstate`, wrong format, bad bundle digest, bad blob
  digest, cross-platform bundle, wrong Machinen version, and unsupported
  snapshot engine before downloading blobs.
- Streaming downloader resumes a partially downloaded blob when the server
  supports `Range`.
- Streaming downloader restarts cleanly when `Range` is absent.
- Materialization creates a directory with `meta.json`, `state.vmstate`, and
  `federated-machine.json`.
- Cache hits avoid network blob downloads and re-verify file hashes or trust a
  recorded verified marker depending on the final performance choice.
- Registry sidecar can publish an existing fake snapshot directory and serve a
  dumb HTTP layout.
- GC mark-and-sweep preserves blobs referenced by retained bundles and deletes
  unreferenced blobs.

These tests should live beside the current `artifacts.test.ts` and `pull.test.ts`
coverage, using small fake files so the main CI lane stays fast.

### Requires the machinen CI lane

The real-VM lane should add a vmstate pull leg once 2a exists:

1. Build the real Node guest.
2. Boot it with `machinenDriver()`.
3. Increment the counter twice.
4. Publish vmstate through the sidecar.
5. Create a second client with
   `machinen+pull+http://registry...?artifact=vmstate`.
6. Assert the restored VM's next increment is `3`.
7. Restore the same bundle a second time and assert the two restored VMs diverge
   independently.
8. Assert entropy diverges across two restores from the same bundle.
9. Assert a fabricated cross-arch manifest fails at resolve time before blob
   download.

The existing CI lane already has the right honesty contract: x64 with usable KVM
runs and enforces; arm64 hosted runners report unavailable until KVM exists.
Phase 2 should keep that shape and avoid mocking real restore success in the
machinen lane.

## Phasing within Phase 2

### Phase 2a — explicit publish and pull restore

Goal: one source VM, one registry URL, one consumer restore.

Scope:

- Add `artifacts.vmstate` types and resolver selection.
- Add a bundle manifest reader/verifier.
- Stream files to a content-addressed blob cache.
- Materialize a local snapshot dir.
- Add a minimal sidecar or script that publishes an existing `snapshotMachine()`
  directory into the registry layout.
- Serve the layout over HTTP with range support.
- Add fake-bundle unit tests and one real machinen e2e assertion.

Non-goals:

- Automatic snapshot on GET.
- Multi-version artifact selection.
- Compression.
- Full GC.
- Native fork integration.
- Production auth.

This is the smallest increment that proves "ship the running process" without
overbuilding the registry.

### Phase 2b — streaming, resume, and cache economics

Goal: make 2.5GB artifacts tolerable to pull repeatedly.

Scope:

- Robust resumable downloader with progress hooks.
- Cache index with verified blob metadata.
- Optional zstd-published blobs after measurements.
- Separate artifact fetch timeout from restore timeout.
- Better error messages for partial downloads and cache corruption.
- Registry compatibility with nginx/object storage/CDN static serving.

### Phase 2c — fork-by-pull, GC, and operator ergonomics

Goal: make vmstate federation usable as a workflow.

Scope:

- `forkByPull` helper or documented recipe that snapshots once and restores
  multiple clones.
- Producer and consumer GC policies.
- Registry index listing bundles by name, version, created time, digest, and
  platform.
- Demo script with timings and cache-hit output.
- Documentation updates to `guest-protocol.md`, `machinen-driver.md`, and
  writing-a-machine docs.

## Economics

The measured real-VM numbers matter:

- Fresh VM boot to healthy: about 9.5s with current node install path.
- Whole-VM snapshot: about 7s.
- Restore to healthy: about 5.5s.
- Bundle size: about 2.5GB.

On a 1Gbps link, 2.5GB costs roughly 20-25s before restore. Cold-cache vmstate
pull is therefore slower than redeploying a simple machine from image. On a
10Gbps link near the registry, transfer can be a few seconds and restore starts
to win. With a warm consumer cache, restore can beat cold boot decisively. With
expensive warm state, vmstate can win even over slow links: a JVM warmed for 40s,
a model loaded for minutes, or a costly in-memory index may be worth shipping.

The design should not sell vmstate as universally faster. It is a federation
primitive for moving expensive warm state and creating divergent clones. For
stateless services or cheap boot paths, Phase 1 image pull or normal deploy is
better.

## Demo hook sketch

Add `scripts/demo-vmstate-pull.mjs` after 2a: build the remote guest, boot it
with `machinenDriver()`, increment the counter to a warm value, start the
sidecar, publish a vmstate bundle, then create a second `createMachines()` host
using `machinen+pull+http://127.0.0.1:<registry>?artifact=vmstate&version=^1.0.0`.
The first call on the consumer restores the VM and prints `counter 2 -> 3`; a
second consumer restores the same digest and proves divergence. The script
prints snapshot, transfer, restore, cache-hit timings, and exits 78 with the
same honest reason style as `scripts/machinen-e2e.mjs` when KVM or Machinen is
unavailable.

## Recommendation

Build Phase 2 as registry-shaped vmstate pull, not guest-served vmstate. Keep
the consumer path as an additive extension of `resolvePullEntry()` and
`machinenDriver()` restore. Put the new producer behavior in a host-side machine
registry sidecar that can publish explicit snapshots into a content-addressed
HTTP layout. Start with Phase 2a's explicit publish/pull/restore loop, because
it proves the primitive and reveals the real costs before resume, compression,
GC, and fork ergonomics complicate the surface.
