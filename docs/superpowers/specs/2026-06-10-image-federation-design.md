# Design: image/vmstate federation — pull-and-boot machine entries

Date: 2026-06-10
Status: Phase 1 implemented (see "Phase 1 implementation notes" at the end)

## The concept

Module Federation has three federated artifacts, and this repo currently
implements two of them:

1. **The manifest** (`mf-manifest.json`) — federated. Machines serve
   `GET /mf-manifest.json`; the plugin fetches it over the network and
   negotiates versions against it.
2. **The types** (`@mf-types` analog) — federated. Machines serve
   `GET /mf-types.ts`; `machinen-bindgen` pulls bindings purely from deployed
   URLs.
3. **The code** (`remoteEntry.js`) — **not federated.** This is the missing
   leg. In real MF, the host fetches the remote's executable artifact from
   the remote's deploy and runs it locally. Here, `machinen+http://` attaches
   to a machine that is already running somewhere (nothing moves), and
   `machinen://<path>` boots an image that must already exist on the
   consumer's local disk (nothing moves over the network either).

The proposal: make the **machine image — and, beyond what MF can do, the
warm snapshot — the federated artifact**. A new entry kind tells the runtime
plugin to *fetch the artifact from where the machine is published, cache it,
boot it locally through the existing drivers, and bind the exposed
functions*. `import { strings } from './generated/java_machine'` then means
"get me a running java_machine", with the artifact transfer as invisible as
MF's `remoteEntry.js` fetch. Artifact distribution = `remoteEntry.js`
delivery; machinen (or the process driver) = the script loader; manifest,
bindgen, version negotiation, call policy stay exactly as they are.

The machinen-only superpower MF has no analog for: the artifact can be a
**warm snapshot** — code *plus heap*. Pulling one is `remoteEntry.js` with
the JIT already warmed, the caches already hot, the model already loaded.

## Grounding: how MF actually loads a remote

From [module-federation.io's manifest docs](https://module-federation.io/guide/basic/manifest-snapshot):
`mf-manifest.json` "describes which modules the producer exposes, **where
the remote entry is**, which assets those modules need, which shared
dependencies are available, and where the type files are." The runtime flow
when a remote points at a manifest:

```
Host configures remotes
  -> request mf-manifest.json
  -> parse Manifest
  -> generate Snapshot (pre-resolved manifest info)
  -> resolve the final remoteEntry URL from Snapshot
  -> load remoteEntry, expose, shared, and preload assets
```

Two things matter for the mapping:

- **The manifest tells you where the artifact is.** The host doesn't guess a
  `remoteEntry.js` URL; the manifest's `remoteEntry` field carries it, and
  the runtime resolves the final URL from the snapshot. Our manifest should
  do the same: an `artifacts` block that says where the image/snapshot is.
- **`loadEntry` is the documented extension point** — "allows for full
  customization of remotes, enabling you to extend and create new remote
  types" ([runtime hooks](https://module-federation.io/guide/runtime/runtime-hooks)).
  `plugin.ts` already claims machine entries via this hook and returns a
  virtual container (`init`/`get`) instead of executing fetched JS. Pull
  entries extend the same claim with a fetch phase — no new MF machinery.

## The mapping table

| MF concept | Today in this repo | With image federation |
| --- | --- | --- |
| `remoteEntry.js` (executable artifact, fetched from the remote's deploy) | — *(missing: attach moves nothing, local boot reads local disk)* | **cold image** (`.js`/`.jar`/`.py` guest bundle or rootfs) fetched from the machine's origin |
| *(no MF analog)* | `.snap` / vmstate bundles, produced and consumed locally | **warm snapshot** — code + heap, fetched and restored; "remoteEntry.js with the heap included" |
| manifest's `remoteEntry` field (where the artifact lives) | — | `manifest.artifacts` block (href + format + digest + platform) |
| script loader (`getRemoteEntry` / `createScript`) | — | the boot-capable driver: `processDriver()` spawn, `machinenDriver()` VM boot/restore |
| `mf-manifest.json` | `GET /mf-manifest.json` | unchanged, plus the `artifacts` block |
| MF Snapshot (pre-resolved manifest) | — | the resolved artifact plan: digest-pinned cache entry + local path |
| `@mf-types` / DTS distribution | `GET /mf-types.ts` | unchanged |
| `requiredVersion` semver negotiation | entry `?version=` vs manifest | unchanged — checked **twice**: against the origin manifest before downloading, and against the booted clone (existing `checkVersion`) |
| share scope (shared deps loaded once, reused across remotes) | — | content-addressed artifact cache (`.machinen/cache/<digest>`) + shared base rootfs/kernel assets that all VM machines reuse |
| `loadEntry` hook | claims `machinen://` + `machinen+http://` | same hook also claims `machinen+pull+http://` |
| `preloadRemote` | `plugin.warm()` | `warm()` also pre-pulls artifacts (download before traffic) |

## Entry semantics: one new kind, and "every machine is its own registry"

### The two candidate shapes, and why they converge

1. *A third entry kind* that names where to fetch from.
2. *Guest protocol artifact endpoints* so a running machine can serve its own
   clone.

These are not alternatives — (2) is what makes (1) uniform. The entry names
an **HTTP base URL that serves a manifest plus artifacts**. A running
machine already serves `/mf-manifest.json`; give it `/mf-image` and
`/mf-snapshot` and it *is* a registry serving exactly one machine: itself.
A static registry (a directory of files behind any web server, a CDN, a CI
artifact store) serves the identical layout with zero compute — exactly like
`remoteEntry.js` on a CDN. Fork-by-fetch falls out for free: pull from a
live machine's `/mf-snapshot` and you have forked it over HTTP — which on
amd64 (where machinen 0.4.0's `fork()` is broken) is already the workaround
the driver recommends, now made network-transparent.

### Proposed entry grammar

```
machinen://<local-path>            boot from local disk          (existing)
machinen+http://host:port          attach to a deployed machine  (existing)
machinen+pull+http://host:port[/path]   NEW: fetch artifact, then boot locally
```

`machinen+pull+https://` for TLS, mirroring how attach composes today
(everything after `machinen+` is the URL, so `machinen+https://` already
works). Parse-order note: `parseMachineEntry` must claim the
`machinen+pull+` prefix **before** the generic attach branch — the existing
`/^machinen\+\w+:\/\//` attach test would otherwise swallow a hypothetical
`machinen+pull://` form and attach to a nonsense `pull://` URL. The explicit
two-plus form sidesteps that and keeps the transport visible.

Query params (all optional):

- `?version=^1.0.0` — exactly today's semantics, checked at the origin
  *before* downloading (fail fast, before gigabytes move) and re-checked
  against the booted clone's manifest (existing `checkVersion`, which stays
  authoritative).
- `?artifact=image|snapshot` — which artifact to pull. Default `image`
  (deterministic, cacheable, the strict `remoteEntry.js` analog). `snapshot`
  opts into the warm clone / fork-by-fetch behavior.
- `?digest=sha256:...` — pin the exact artifact (reproducible boots; skips
  the network entirely on cache hit).

`MachineSpec.kind` grows `'pull'` with `url` (base) carried like attach.

### Before/after `machinen.config.json`

```json
{
  "machines": {
    "java_machine": { "url": "machinen+http://127.0.0.1:3802", "version": "^1.0.0" }
  }
}
```

becomes (the *only* end-user visible change):

```json
{
  "machines": {
    "java_machine": { "url": "machinen+pull+http://127.0.0.1:3802", "version": "^1.0.0" }
  }
}
```

`import { strings } from './generated'` is untouched; bindgen is untouched
(it fetches `/mf-manifest.json` / `/mf-types.ts` from the same base URL
either way). The one operator-visible requirement: the client needs a
boot-capable driver (`processDriver()` / `machinenDriver()`), same as
`machinen://` entries today — `httpAttachDriver()` cannot boot what it
pulls. A `?artifact=snapshot` example with prod overrides: dev attaches to a
local machine, prod sets `MACHINEN_REMOTE_JAVA_MACHINE=machinen+pull+https://registry.internal/java_machine?artifact=snapshot`
and every instance boots its own warm clone. No code change.

## Protocol additions (additive to guest protocol v3)

### Manifest `artifacts` block

The analog of `mf-manifest.json`'s `remoteEntry` field. Presence is the
capability advertisement (like `remoteEntry` itself — no feature flag):

```json
{
  "name": "java_machine",
  "protocol": 3,
  "version": "1.2.0",
  "artifacts": {
    "image": {
      "href": "/mf-image",
      "format": "guest-bundle",
      "mediaType": "application/java-archive",
      "digest": "sha256:9f2c...",
      "bytes": 1048576,
      "platform": "any"
    },
    "snapshot": {
      "href": "/mf-snapshot",
      "format": "app-state@1",
      "platform": "any"
    }
  },
  "exposes": { "...": "unchanged" }
}
```

- `format` is what the consumer-side resolver dispatches on:
  - `guest-bundle` — a raw guest program (`.js`/`.jar`/`.py`); boots via the
    process driver's extension dispatch, or inside a VM via `machinenDriver`.
  - `app-state@1` — image reference + dehydrated state; the federated `.snap`.
  - `machinen-vmstate@1` (Phase 2) — tarred whole-VM bundle
    (`meta.json` + `state.vmstate` + marker), restorable by `machinenDriver`.
- `digest` is required for `image` (immutable → cache key). Live snapshots
  are generated per request, so their digest arrives in response headers
  instead.
- `platform` is `any` for app-level artifacts; `linux/amd64` etc. for
  vmstate bundles — the resolver refuses cross-arch restores with a clear
  error instead of a cryptic VMM crash.

### `GET /mf-image`

The machine's own program artifact, `application/octet-stream`, with
`x-mf-digest` / `x-mf-format` headers matching the manifest. The Node
reference guest serves its own bundle file; Java its jar; Python its
`main.py`. Static registries serve the file directly. Immutable,
digest-addressed → cache forever, `Range` honored when feasible (Phase 2
for large bundles).

### `GET /mf-snapshot`

A **freshly dehydrated** app-state bundle from a live guest (requires the
existing `state` capability):

```json
{ "name": "java_machine", "imageDigest": "sha256:9f2c...", "state": { "...": "..." }, "createdAt": "..." }
```

Deliberate split: the snapshot carries the image **by digest reference, not
by value**. State is tiny (~190 bytes in the demos) and changes constantly;
the image is big and immutable. The consumer pulls `/mf-snapshot` every
time and `/mf-image` only on digest miss — the same shape as MF shipping a
small manifest plus a cached `remoteEntry.js`, and it makes per-PR
warm-clone workflows nearly free after the first pull. `Cache-Control:
no-store` on the snapshot response; the image endpoint is the cacheable one.

For vmstate there is a structural asymmetry worth stating: **a guest cannot
snapshot its own VM** — the VMM on the machine's host does. So
`machinen-vmstate@1` artifacts are published by the operator side (the
deployment that runs `machinenDriver`, via `snapshotMachine()` + a publish
step) or served from a static registry — not self-served by the guest.
Phase 2 embraces that: vmstate federation is registry-shaped, not
fork-by-fetch-shaped.

## Where it boots: resolver in the plugin, drivers unchanged

The key implementation insight: **the drivers already know how to boot every
artifact format from a local path.** `processDriver` dispatches on `.snap`
suffix and file extension; `machinenDriver` dispatches on
snapshot-dir-vs-`.js`. So the fetch phase should *not* enter the
`MachineDriver` interface. Instead:

- New `src/artifacts.ts`: `resolvePullEntry(spec, opts): Promise<MachineSpec>` —
  fetch the origin manifest, early version check, pick the artifact per
  `?artifact=`, download to `.machinen/cache/<digest>.<ext>` with digest
  verification (skip download on cache hit), materialize it in
  driver-bootable shape (`app-state@1` → write a local `.snap` bundle whose
  `image` field points at the cached image file; `machinen-vmstate@1` →
  untar to a cache dir), and return the spec rewritten to
  `kind: 'image', image: <cachedPath>`.
- `plugin.ts` `ensureMachine()` grows one line-of-concept before
  `driver.boot(spec)`:
  `if (spec.kind === 'pull') spec = await resolvePullEntry(spec, ...)`.
  The cache map stays keyed by the original entry string, so
  `restartOnCrash` reboots from the already-cached artifact —
  deterministic restarts, no surprise re-pull of *newer* state mid-incident.
- Two new hooks for observability, mirroring the snapshot pair:
  `beforeArtifactFetch` / `onArtifactFetched` (spec, descriptor, bytes,
  cache hit/miss, duration). `warm()` therefore pre-pulls for free.

`MachineDriver` stays a one-method interface. No type changes to
`MachineHandle`. `httpAttachDriver` keeps rejecting non-attach specs with
its existing clear error.

## Honest constraints

- **vmstate bundles are ~2.5GB** (RAM + rootdisk + vCPU state) and dump in
  ~7s; restore-to-healthy is ~5.5s locally. On a 1Gbps link the transfer
  alone is ~20–25s, so a *cold-cache* pulled-vmstate boot loses to the ~9.5s
  fresh VM boot. The economics only work when (a) the cache is warm —
  per-PR environments cloning one staging snapshot pay the transfer once —
  or (b) warmth is worth more than transfer: 40s JVM warmup, minutes of
  model-weight loading. Say so in the docs; don't sell pull-vmstate as
  universally faster.
- **vmstate is architecture-bound**: an amd64 bundle does not restore on
  arm64. The `platform` field plus a resolver-side check turns this into a
  readable error. App-state artifacts (`app-state@1`, `guest-bundle`) are
  `platform: any` — that is the quiet argument for Phase 1's flavor: the
  *portable* warm snapshot.
- **`fork()` is broken on amd64 machinen 0.4.0**; snapshot+boot-from-bundle
  is the documented workaround. Pull entries are that workaround with a URL
  — a feature, but also a dependency: real VM fork-federation quality rides
  on upstream fixes.
- **App-state snapshots only capture what `dehydrate()` covers.** Open
  sockets, in-flight work, OS state — gone. That's the existing `.snap`
  contract, now crossing a network: heap contents (possibly secrets) become
  fetchable. The protocol is deliberately unauthenticated and
  loopback-by-default; `/mf-image` and `/mf-snapshot` *amplify* that stance
  — anyone who can reach a machine can take its code and its memory. Keep
  the no-auth scope, but the guest-protocol doc must state this in bold.
- **Live `/mf-snapshot` on big state is a DoS-shaped endpoint** (dehydrate
  on every GET). Fine at ~190 bytes; a guest with 100MB of state should
  rate-limit or pre-bake. Note it, don't engineer for it yet.
- **Pull = clone semantics.** Every consumer gets an *independent copy*;
  divergence is the point (forks, previews) and the hazard (you do not want
  three clones of `db_machine` each believing it is the database). **Attach
  remains the right verb for big stateful singletons and for data-residency
  topologies** — the gravity demo's whole argument is that the data must
  *not* move; pulling the db would move it. The docs should give a blunt
  rule: *attach to state you share, pull state you want to own.*

## Phased plan

### Phase 1 — app-state pull federation (process driver, no KVM, demo-able today)

Tightly scoped to the portable flavor:

1. `types.ts`: `MachineSpec.kind: 'pull'`, `machinen+pull+http(s)://`
   parsing (before the attach branch), `ArtifactDescriptor` +
   `MachineExposeManifest.artifacts`.
2. `artifacts.ts`: resolver + sha256-addressed cache under
   `.machinen/cache/` (formats: `guest-bundle`, `app-state@1`).
3. `plugin.ts`: the pull branch in `ensureMachine`, two artifact hooks.
4. `guest.ts` (Node reference guest): serve `/mf-image` (own bundle path)
   and `/mf-snapshot` (digest-ref + dehydrated state); `artifacts` block in
   the manifest. Java/Python guests follow as conformance work, not
   blockers.
5. `scripts/demo-pull.mjs`: host A boots java_machine and works the counter
   warm; host B's config says `machinen+pull+http://A?artifact=snapshot`;
   B's first import pulls the snapshot, boots an *independent clone* that
   resumes at the same counter, and both continue divergently —
   fork-by-fetch with zero KVM. Cold `?artifact=image` pull demoed in the
   same script.
6. Tests: resolver unit tests (digest verify, cache hit, version-check-
   before-download, platform refusal), an end-to-end pull test against the
   in-process/process guests, conformance additions for the new endpoints.

### Phase 2 — vmstate pull federation (machinen driver, real VMs)

`machinen-vmstate@1` tar format; a publish step
(`snapshotMachine()` → tar + manifest into a static registry dir); resolver
untar + `platform` enforcement; `Range`/resumable downloads and fetch
progress via the artifact hooks; the machinen CI lane gains a
pull-restore leg. Driver code itself: unchanged (it already boots snapshot
dirs).

### Phase 3 — registry maturation (only if earlier phases earn it)

Multi-machine registry index, multiple published versions with semver-range
artifact *selection* (true MF-style negotiation at the artifact level, not
just validation), delta/layered images.

## Phase 1 implementation notes (deviations from the spec above)

Phase 1 landed as scoped. Implementation forced these refinements:

- **`ArtifactDescriptor` gained an `ext` field** (".js"/".jar"/".py"…). The
  spec's `mediaType` could not safely drive the cached filename, and drivers
  pick boot commands by file extension — so the origin states it explicitly
  and the resolver validates it (`/^\.[A-Za-z0-9]{1,16}$/`) so a hostile
  manifest cannot write outside the cache dir.
- **`?digest=` pinning does not skip the manifest fetch** — only the artifact
  download on cache hit. The manifest is needed for `href`/`ext`, and it is
  tiny; the spec's "skips the network entirely" was overpromising.
- **Rewritten specs carry `pulledFrom`** (the original pull entry) so hooks
  and errors keep provenance after the spec is rewritten to a local
  `kind: 'image'` boot.
- **Cache hits are re-hashed** before reuse: a corrupt cache entry (partial
  write, disk fault) is evicted and re-downloaded. Cheap at Phase 1 artifact
  sizes; revisit for multi-GB Phase 2 bundles.
- **Materialized `.snap` bundles are content-addressed** (sha256 of the
  bundle JSON), so a memoized resolution stays valid across
  `restartOnCrash` reboots and identical pulled states share one file.
- **Unsupported artifact endpoints answer 404** (the routes simply don't
  exist without the capability), and the conformance suite now gates this:
  advertised artifacts must be digest-true, unadvertised endpoints must
  answer 404/501. Java/Python guests pass untouched (artifact publishing
  there is follow-up work, as scoped).
- Pull resolution shares the plugin's `bootTimeoutMs` budget (it runs inside
  the boot phase); raise it for slow links the same way as for slow boots.
- **`?digest=` pins on snapshot pulls constrain the image the snapshot
  references** (review finding): live snapshot bytes change per request, so
  the pin can only ever mean the underlying code. A mismatch fails before
  any image bytes move; the spec's original wording left the snapshot case
  undefined.
- **Snapshot bodies are validated as JSON objects** before field access
  (null/array/scalar bodies produce machine-named errors), and cache writes
  tolerate concurrent same-digest writers (rename-onto-existing fallback);
  adversarial origins (HTML responses, truncated downloads, racing pulls)
  are pinned by tests.
- Phase 1 buffers whole artifacts in memory during download and digest
  verification — fine at app-bundle sizes; Phase 2's multi-GB vmstate
  bundles need streaming hash-while-writing and `Range` resume.

## Recommendation

Build Phase 1. It is small (one new module, one parse branch, two guest
endpoints, no driver changes), it completes the MF analogy precisely at the
point where it is currently dishonest (the manifest and types federate, the
artifact does not), and its demo — fork-by-fetch of a warm machine over
plain HTTP, no hypervisor — is the most legible version of the
machinen.dev pitch this repo can make. Phase 2 is where the superpower
lives, but its economics (2.5GB, arch-bound, fork-broken-upstream) mean it
should ship behind the honest framing above, registry-shaped rather than
live-fork-shaped.
