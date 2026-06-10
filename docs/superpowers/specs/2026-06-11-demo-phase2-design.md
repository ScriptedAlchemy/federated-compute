# Phase 2 demo experience: ship the running process

Date: 2026-06-11
Status: proposed
Scope: demo design only. This document assumes
`2026-06-11-demo-evolution-plan.md` has landed as the Phase 1 demo baseline:
page 01 has the lifecycle arc with fork-by-pull, and page 02 has
deploy-by-pull gravity with topology edge taxonomy, a cache node, and dynamic
clone nodes.

No `apps/host/**` implementation changes are part of this design document.

## 1. Thesis

Phase 1 teaches: **state can be an artifact when the guest participates**.
The app-level snapshot is tiny, portable, and cooperative: the guest has a
state capability, `dehydrate()` defines what survives, and pull federation
boots an independent process clone from that declared state.

Phase 2 should teach one deeper sentence without adding a new page:

> **A whole running VM can be the artifact: heap, disk, vCPU state, warm cache,
> and in-flight work move together.**

The demo should make that feel different from Phase 1. The viewer should not
just see a counter restored; they should see a process that was visibly busy,
with private in-memory progress, freeze mid-flight, move to another host, and
continue from the exact same heap. The cost should be just as visible:
multi-GB transfer, platform binding, and real hardware requirements.

## 2. Recommendation summary

**Hero moment:** add a Phase 2 mode to the existing lifecycle card:
`start live VM job` -> `freeze while running` -> `pull vmstate bundle` ->
`restore on clone host` -> `resume exactly where it stopped`. The job is a
long-running search with visible in-memory progress and a hot cache, not a
simple counter. Phase 1 remains the cooperative app-state lane; Phase 2 is the
zero-cooperation whole-heap lane.

**Hardware fallback:** use server-side capability detection. On capable
machines, the card runs real KVM/HVF-backed microVM operations. Elsewhere, the
card shows a clearly labeled recorded trace replay plus disabled live controls
and a direct CLI pointer: `pnpm demo:machinen`. Do not fake success, and do not
hide the real-VM card entirely.

**What gets cut:** do not add a third page, do not make the EU-residency story
a separate interactive flow, and do not add another standalone "move my
laptop process" page. Fold Phase 2 into the lifecycle arc and reuse the
gravity page only for transfer economics and placement tradeoffs.

## 3. Approaches considered

### Recommended: deepen the existing lifecycle card

Add a Phase 2 tab or lane inside act 04 of page 01:

- **App-state fork** shows Phase 1: cooperative, tiny, portable.
- **Whole-VM move** shows Phase 2: zero-cooperation, GB-scale, arch-bound.

This keeps the story compact. The same visual grammar already explains
machine lifecycle and artifact pulls, so Phase 2 can teach by contrast instead
of by introducing a new surface.

### Rejected: create a third "VM mobility" page

A dedicated page would give the VM story more room, but it would also split
the demo into three narratives: dashboard, gravity, and VM mobility. The
current plan already warns that complexity should stay flat. A third page
would make Phase 2 feel like a separate product instead of the next depth
level of the same lifecycle arc.

### Rejected: make EU residency the Phase 2 hero

EU residency is important, but the existing gravity page already teaches the
right placement rule: move code to data, not data to code. Phase 2 can add
vmstate economics to that page, but the visceral "heap-and-all" moment belongs
on the lifecycle card where the viewer can watch one process stop and resume.

## 4. Page 01 hero moment: "the hot solver survives"

### Interaction

The Phase 2 lifecycle lane uses a deliberately simple long-running workload:
a **hot route solver** running inside a real Machinen microVM. It searches a
fixed map for a low-cost route while memoizing partial paths; the algorithm is
small enough to explain in one sentence, but it creates a visible heap shape:

- a ticking iteration counter
- a partially filled in-memory cache
- the current best result
- a private heap fingerprint
- a short event log with the VM id, process pid, and monotonic tick

The guest may expose telemetry through normal RPC so the UI can draw progress,
but it does **not** expose an app-state snapshot capability for this lane. The
lesson is: telemetry is not serialization. The snapshot is taken by the VMM
from outside the process.

Stepper:

```
1 · start live VM job
2 · freeze while running
3 · publish vmstate bundle
4 · pull to clone host
5 · restore + resume
```

The key interaction is step 2 -> 5. The viewer starts the job, lets progress
advance, then clicks **freeze while running**. The source VM stops. The UI
shows a vmstate bundle produced from RAM + rootdisk + vCPU state. The clone
host pulls the bundle, restores it, and the progress row continues from the
same iteration and cache fill rather than restarting at zero.

Success copy:

> The source VM is gone. The resumed VM did not call `rehydrate()`. It kept
> running because the heap moved.

### UI sketch

Use the existing card and topology language, not a new visual system:

- A two-lane lifecycle card: **Phase 1 app-state** and **Phase 2 whole VM**.
  Phase 1 can be collapsed after completion; Phase 2 is the expanded lane.
- A compact "heap witness" strip in the Phase 2 lane:
  `iteration 18,420` · `cache 73% warm` · `best 0.0341` ·
  `heap fp ab12c9` · `pid 142`.
- A VM artifact transfer rail in the topology map:
  thick `artifact` edge, packet train animation, label
  `2.5 GB vmstate · linux/amd64 · sha256:...`.
- A source VM node that turns gray after freeze and a clone node that lights
  up on restore.
- An activity log row that explicitly separates the two mechanisms:
  `app-state snapshot: dehydrate/rehydrate` vs
  `vmstate snapshot: VMM dump/restore`.

### What it teaches

- Whole-VM restore preserves process heap without app-level cooperation.
- The Phase 1 and Phase 2 snapshots are related but not interchangeable.
- VM warmth is valuable when the heap contains work: warmed caches, loaded
  models, JIT state, or an in-progress agent task.
- Pulling a vmstate artifact creates an independent resumed machine; attach
  remains the verb for shared singletons.

### Server/API needs

- `GET /api/capabilities/machinen` returning:
  `available`, `reason`, `platform`, `driver`, and `canRunLiveVmstateDemo`.
- `POST /api/vm-demo/start` to boot the real microVM and start the hot solver.
- `GET /api/vm-demo/status` for solver telemetry, vm lifecycle state, artifact
  size, platform, and timings.
- `POST /api/vm-demo/freeze` to call `snapshotMachine()` and dispose the
  source VM.
- `POST /api/vm-demo/pull-restore` to resolve a `machinen-vmstate@1` artifact
  through the Phase 2 pull resolver and boot the restored clone.
- Artifact hook events with progress fields for multi-GB downloads:
  `bytesTotal`, `bytesTransferred`, `bytesPerSecond`, `cacheHit`,
  `durationMs`, `artifact`, `format`, `platform`, and `digest`.
- Recorded trace endpoint for fallback:
  `GET /api/vm-demo/replay/default`, serving a fixed event stream captured
  from a real KVM run in this repo.

### KVM dependency and effort

- KVM dependency: **required for live run**, **none for replay**.
- Effort: **L**. This is the core Phase 2 demo surface and needs new server
  orchestration, progress streaming, replay data, and UI state handling.

## 5. Honest hardware story

### Capability detection

The server should detect real-VM support before the page tries to run anything:

- Linux: `/dev/kvm` exists and is usable.
- macOS Apple Silicon: HVF path is available if the runtime supports it.
- `@machinen/runtime` optional dependency is installed or can be loaded.
- Base Machinen assets are present or the error explains how they will be
  installed.
- Host architecture matches any selected vmstate artifact platform.

The response should use plain reasons the UI can show:

- `live` — real VM demo can run here.
- `missing-kvm` — no `/dev/kvm`; live controls disabled.
- `missing-runtime` — install dependency or run the setup command.
- `unsupported-platform` — vmstate artifact is arch-bound.
- `assets-missing` — live demo can run after Machinen assets are installed.

### Recommended fallback

Use **recorded trace replay, clearly labeled**, not a pure disabled card and
not a process-driver impersonation.

Why:

- A disabled card is honest but misses the teaching moment on common machines.
- A process-driver live substitute already exists in Phase 1 and would blur
  the distinction Phase 2 is trying to teach.
- A recorded trace can show real timings, GB-scale transfer, and exact UI
  events while saying plainly: "Replay from a real KVM run; not executing a VM
  on this host."

Fallback UI:

- Header badge: `Replay: real KVM trace` or `Live: KVM`.
- Disabled live buttons with reason text:
  `Live VM controls are disabled: no /dev/kvm on this host.`
- Primary available action: **play recorded VM move**.
- Secondary CLI pointer:
  `Run the live version with pnpm demo:machinen on a machine with /dev/kvm.`
- Trace metadata panel:
  `captured on linux/amd64`, `snapshot 7.0s`, `restore 5.5s`,
  `bundle 2.5 GB`, `warm call 1-2ms`.

Replay must never increment live counters or claim current hardware success.
It should use separate copy and telemetry labels so screenshots remain honest.

### KVM dependency and effort

- KVM dependency: **optional** for the web demo as a whole.
- Effort: **M** for detection and replay plumbing, plus **S** to capture and
  version the first trace fixture.

## 6. Scale honesty in the topology map

Phase 1 artifact edges are KB-scale. Phase 2 vmstate artifacts are GB-scale.
The topology map should make that visible instead of compressing all pulls
into the same animation.

### Transfer display

For `machinen-vmstate@1` pulls, artifact edges show:

- total size: `2.5 GB`
- transferred bytes and percent
- throughput estimate
- platform: `linux/amd64` or `linux/arm64`
- cache state: `miss`, `hit`, or `partial resume`
- digest prefix
- elapsed time

The edge remains dimmed after completion as provenance:
`clone restored from vmstate sha256:ab12...`.

### Race card: "which is faster here?"

Add a small comparison card inside the lifecycle act, not a new page. It has
two bars:

- **Cold VM boot + first call**: measured locally, around `9.5s` on the
  documented KVM path.
- **Pull warm VM + first call**: `transfer + restore + first call`.

The card should not always crown vmstate as faster. It asks "which is faster
here?" and answers from real or replayed numbers:

- cold-cache 2.5 GB over 1 Gbps may lose to cold boot
- warm-cache restore may win
- a workload with 40s JVM warmup or minutes of model load changes the answer

This is the economics lesson: vmstate is not magic compression; it is a
tradeoff between transfer cost and preserved warmth.

### Server/API needs

- Extend artifact hook payloads for progress rather than only completion.
- Preserve timing phases separately:
  `dumpMs`, `publishMs`, `transferMs`, `restoreMs`, `firstCallMs`,
  `coldBootFirstCallMs`.
- Cache metadata for large artifacts:
  `bytesOnDisk`, `digest`, `platform`, `lastVerifiedAt`, and `wasRehashed`.
- Optional link from replay traces to the raw captured timing JSON.

### KVM dependency and effort

- KVM dependency: **none** for rendering; **optional** for live timings.
- Effort: **M** if Phase 2 hooks expose progress, **L** if the demo must build
  its own progress polling around downloads.

## 7. Page 02 gravity: keep the current story, add one Phase 2 annotation

The existing deploy-by-pull gravity page should remain the data-gravity hero.
It already teaches the key residency rule:

> move code to the data; do not drag raw data to the code.

Phase 2 should not add a new EU-residency interaction. That story is better
as copy attached to the existing scenario:

> The same placement rule handles EU tenants: restore the processing machine
> inside the EU, send answers out, keep raw data in-region.

### What changes

Add one small **artifact economics** annotation to the gravity comparison:

- Phase 1 image pull:
  `N KB image · cacheable · fast to deploy near data`.
- Phase 2 vmstate pull:
  `2.5 GB vmstate · warm heap · only worth it when warmth beats transfer`.

Do not add another gravity toggle. Link the annotation back to the lifecycle
race card for the detailed numbers.

### What gets cut

- No separate "move an EU tenant mid-task" button.
- No simulated personal laptop-to-desktop flow.
- No "pull the db snapshot here" action. That remains an anti-pattern callout:
  pull creates clones, and databases are usually shared state.

### Server/API needs

- No new gravity control API required for the first Phase 2 pass.
- Reuse the lifecycle race card's published timing constants or replay timing
  fixture when rendering the annotation copy.

### KVM dependency and effort

- KVM dependency: **none** for the gravity page annotation.
- Effort: **S**.

## 8. Complexity budget

Keep the demo at two pages:

- Page 01: lifecycle arc deepens with a Phase 2 lane.
- Page 02: gravity remains placement and economics.

Do not add a third page unless future implementation proves the lifecycle card
cannot fit both lanes without hiding the core interaction. The current design
assumes it can fit because Phase 1 and Phase 2 are contrasts of the same
operation: freeze, move, restore.

Complexity stays flat by merging and cutting:

- Merge Phase 2 into the existing lifecycle act.
- Reuse topology edge taxonomy, cache node, clone nodes, and activity log.
- Keep the replay inside the same card as live mode.
- Cut separate residency, laptop mobility, and database-pull interactions.

## 9. Element matrix

| element | teaches | UI sketch | server/API needs | KVM dependency | effort |
| --- | --- | --- | --- | --- | --- |
| Phase 2 lifecycle lane | Whole-VM state moves without app-level serialization | Existing lifecycle card gains `whole VM` lane with five-step stepper | VM demo start/status/freeze/pull-restore routes; vmstate artifact hooks | required for live; none for replay | L |
| Hot solver heap witness | Heap survival is visceral, not abstract | Iteration/cache/best/fingerprint/pid strip resumes from exact values | Solver telemetry from guest RPC; no app-state snapshot hook | required for live; none for replay | M |
| Source-to-clone topology | The source dies and the clone owns the resumed heap | Source node grays out; clone node lights; GB artifact edge persists as provenance | Lifecycle status plus artifact provenance | optional | M |
| Recorded trace fallback | Honest learning without KVM | `Replay: real KVM trace` badge, disabled live controls, CLI pointer | Capability route; replay event stream | none | M |
| GB transfer progress | Vmstate economics are visible | Packet train edge with bytes, percent, throughput, platform, digest | Progress-capable artifact hook payloads | optional | M |
| "Which is faster here?" card | Warmth has costs; vmstate does not always win | Two timing bars: cold boot vs pull warm VM | Phase timing fields and replay timing fixtures | optional | S |
| Gravity Phase 2 annotation | Placement story remains; economics deepen | One row comparing image pull vs vmstate pull | Shared timing constants or replay fixture | none | S |
| Capability badges | The demo is honest about hardware | `Live: KVM`, `Replay`, or disabled reason chips | Capability route | none | S |

## 10. Rollout alignment

### Phase 2a: live local vmstate lifecycle

Land the lifecycle lane behind capability detection:

- hot solver guest running in a real microVM
- freeze while running
- restore from local vmstate bundle
- heap witness strip
- KVM detection and disabled-with-reason UI
- replay fixture for machines without KVM

This maps to the runtime increment where `machinenDriver()` can reliably dump
and restore whole-VM state locally, with the timings already documented in
`docs/machinen-driver.md`.

### Phase 2b: vmstate pull artifact

Turn the local restore into real pull federation:

- publish `machinen-vmstate@1` bundle to a registry-shaped directory
- manifest advertises platform and digest
- resolver untars and enforces platform
- topology shows GB artifact transfer and cache state
- lifecycle step 4 becomes `pull to clone host`, not just local restore

This maps to the runtime increment described in the Phase 1 design: tar format,
publish step, platform enforcement, and resolver support for vmstate bundles.

### Phase 2c: scale economics and replay polish

Make the numbers durable enough for demos and docs:

- progress-capable artifact hooks
- resumable/ranged download display if runtime supports it
- race card powered by phase timings
- gravity page annotation using the same timing model
- versioned replay trace captured from CI or a known KVM host

This maps to the runtime increment where multi-GB transfer observability and
operator-facing economics become reliable enough to teach.

## 11. Copy rules

Use blunt, consistent language:

- Phase 1: `app-state snapshot`, `cooperative`, `portable`, `tiny`.
- Phase 2: `whole-VM vmstate`, `zero-cooperation`, `arch-bound`, `GB-scale`.
- Pull semantics: `pull creates an owned clone`.
- Attach semantics: `attach talks to shared state where it already runs`.
- Fallback: `Replay from a real KVM run`, never `simulated VM`.

Avoid these claims:

- "vmstate is always faster than boot"
- "works on every laptop"
- "moves databases safely"
- "captures app state better than app-state snapshots"

The honest pitch is stronger: when warmth matters more than transfer, shipping
the running process is the capability no app-level federation can fake.
