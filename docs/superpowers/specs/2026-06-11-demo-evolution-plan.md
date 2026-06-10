# Demo evolution: showing pull federation (post image-federation Phase 1)

Date: 2026-06-11
Status: proposed — lands AFTER Phase 1 of
[image/vmstate federation](2026-06-10-image-federation-design.md)
Scope: `apps/host/public/index.html`, `apps/host/public/gravity.html`,
`apps/host/src/server.ts`, demo orchestration scripts. No plugin changes
required beyond what Phase 1 already specifies (gaps called out in §8).

## 1. Thesis

The demo (as of f94a705) teaches **attach federation** honestly: real
`loadRemote`, real manifests, real `POST /mf/call` payloads in collapsible
wire traces. Phase 1 (landing now — `f768be8` already added the
`machinen+pull+http(s)://` entry kind, `ArtifactDescriptor`, and the
`pulledFrom` provenance field) completes the MF analogy: the **artifact
moves too**. The demo's next evolution should teach exactly two new
sentences, one per page:

- **Page 01:** *a machine's state is a fetchable artifact — pull it and you
  have forked the machine over plain HTTP* (snapshot pull, fork-by-fetch).
- **Page 02:** *topology is a config change — pull the code to the data and
  watch the map redraw* (image pull, deploy-by-pull).

Everything below serves those two sentences, and total page complexity goes
**down**: one card is cut, two cards merge, two steps and one button are
added. Same honesty contract as today: every number in the UI comes from
real plugin hooks (`beforeArtifactFetch` / `onArtifactFetched`), never from
mock data.

## 2. The story arc

Page 01 becomes a numbered six-act read (markup-only renumbering — the grid
layout stays, no scroll-narrative rebuild):

| act | panel | teaches |
| --- | --- | --- |
| 01 import | hero + topology | entries resolve to machines; the host is a stock MF runtime |
| 02 call | polyglot pipeline | one `loadRemote` shape, three runtimes, RPC on the wire |
| 03 own state | counters | state has an address; it lives in the machine |
| 04 lifecycle | **merged snapshot + pull card** | state survives death (freeze/restore) and state is fissile (fork-by-pull) |
| 05 stream | countdown SSE | async iterables across two boundaries |
| 06 observe | activity log | the hook system is the observability surface |

Page 02 (already "02" in the nav) is act 07: the economics. Its scenario 2
stops being "someone already deployed analytics next to the db" and becomes
"**you** deploy it there, by pull, right now."

Acts 01–03 are unchanged. The new material is concentrated in act 04 and
page 02 so a returning viewer immediately sees what's new.

## 3. Page 01, card by card

### 3.1 Hero (act 01) — touch up only

Add one line to the verbatim `remotes` array in the hero code panel showing
the third entry kind next to the existing attach entries:

```js
// three entry kinds, one runtime:
//   machinen://<path>            boot from local disk
//   machinen+http://host:port    attach to a deployment
//   machinen+pull+http://…       fetch the artifact, boot a local clone
```

Teaches: the entry string is the whole user-facing API change (the design
doc's central claim). Effort: S.

### 3.2 Topology (act 01) — edge taxonomy + cache + dynamic clones

See §5 for the full spec. Summary: edges get a `kind` (rpc | artifact |
wan), the host column grows an **artifact cache** sub-node, and clone nodes
appear dynamically when act 04 forks. Effort: M.

### 3.3 Pipeline, counters, stream, log — unchanged

The counters card (act 03) gains one sentence of foreshadowing in its
concept line: *"…and because state lives in the machine, it can be frozen,
shipped, and forked — that's act 04."* Zero functional change.

### 3.4 CUT: compute playground (add/fib)

Rejected from the future page. It teaches "lazy attach," which the pipeline
and counters cards already demonstrate (first click warms a card), and
add/fib results carry no narrative weight. Keep `POST /api/compute` and
`GET /api/countdown` server-side (the stream card uses countdown); delete
the card. This pays for the lifecycle card's two new steps — net interactive
cards: 5 → 4.

### 3.5 Act 04: the machine lifecycle card (snapshot card, extended)

**Merge verdict: yes.** The snapshot card and the proposed "pull this
machine to me" card are the same machine, the same driver, the same stepper
UI, and the same protagonist (the counter value). Two cards would tell one
story twice; one card tells it once, completely:

```
1 · boot & work   →   2 · freeze + kill   →   3 · restore from .snap
                                                      ↓
              5 · fork again (cache hit)  ←   4 · fork by pull
```

Steps 1–3 are today's card, unchanged. New steps:

- **4 · fork by pull.** The restored `snap_machine` is a running Node
  reference guest — after Phase 1 it serves `/mf-manifest.json`,
  `/mf-image`, and `/mf-snapshot`, i.e. *it is a registry of itself*. The
  host registers a second remote and loads it:

  ```js
  snapHost.registerRemotes([{
    name: 'snap_clone_a',
    entry: 'machinen+pull+http://127.0.0.1:3811?artifact=snapshot',
  }]);
  const counter = await snapHost.loadRemote('snap_clone_a/counter');
  ```

  The wire trace shows the full artifact flow, captured from the artifact
  hooks: `GET /mf-manifest.json` (origin, version negotiated **before**
  download), `GET /mf-snapshot` (~190 B, `Cache-Control: no-store`), image
  digest **MISS** → `GET /mf-image` (N KB, sha256 verified), process boot.
  An independent clone resumes at the origin's counter value.

- **5 · fork again.** Same entry, name `snap_clone_b`. The snapshot is
  re-fetched (tiny, by design); the image is a digest cache **HIT** — 0
  bytes transferred, near-instant boot. This step carries both the
  **fork-race** and the **cache story** (see §6 verdicts): the card now
  shows three counters — origin, clone A, clone B — each with its own `+1`
  button. Increment them separately; they diverge. Narrative line: *"one
  warm machine, forked twice over plain HTTP. Clones own their state —
  divergence is the point. Attach to state you share; pull state you want
  to own."*

A small **lineage strip** (text chips, not a diagram) above the counters
makes the artifact chain explicit:
`image → process → .snap → process′ → clone A / clone B`.

**Phase 2 teaser — text only, no UI.** Card footer, one line: *"Same flow
with a whole microVM — heap, JIT, sockets — is `machinen-vmstate@1`:
~2.5 GB, arch-bound, registry-published (Phase 2). CLI preview:
`pnpm demo:machinen`."* The honest costs stay attached to the promise.

What this card deliberately does **not** claim: a latency win. The origin
is a local child process; "pull to me and calls get faster" is page 02's
job, where a WAN exists. Page 01 act 04 is about state mechanics only.

Server support (all within Phase 1's API):

- Boot `snap_machine` on a **fixed port** so the pull entry is static:
  `machinen://<image>?port=3811` — `processDriver` already honors
  `spec.params.get('port')` (`drivers/process.ts`), so the host knows the
  origin URL without any new plugin API.
- New routes: `POST /api/lifecycle/pull` (steps 4/5; registers
  `snap_clone_a` then `snap_clone_b`), `POST /api/lifecycle/counter`
  `{ target: 'origin' | 'a' | 'b' }`. Rename the `/api/snapshot/*` routes
  to `/api/lifecycle/*` while touching them.
- Step 1 (`boot & work`) becomes the arc's reset: dispose clones, dispose
  origin, and **wipe the demo's cache dir** so every full run shows
  miss-then-hit. The resolver landed (9f3c40d) with a `cacheDir` option in
  `ResolvePullOptions` — point the snapshot plugin at a demo-scoped dir
  (e.g. `.machinen/web-cache`) and `rm -rf` it on reset.
- Wire capture: a new `WireEvent` variant
  `{ type: 'artifact', machine, origin, artifact: 'image' | 'snapshot',
  bytes, digest, cacheHit, ms }` fed from `onArtifactFetched`.

Effort: server S, UI M (stepper extension + three-counter row + lineage
strip). Teaches: fork-by-fetch, snapshot-vs-image split, digest cache,
clone independence — the entire Phase 1 pitch in one card.

## 4. Page 02: deploy-by-pull (gravity scenario 2 rework)

**The strongest single change in this plan.** The lesson panel currently
ends with *"with Machinen, moving the code is literal"* and points at a CLI
demo. Phase 1 lets the web page do it.

### Before / after

Today, `analytics_machine` is pre-deployed in eu-west and scenario 2 is one
button. After: the eu-west region starts with `db_machine` and an **empty
dashed slot** ("no analytics here yet"); scenario 2 is two beats:

1. **`deploy by pull`** — a tiny *region agent* in eu-west pulls the
   analytics **image** from its us-east origin and boots it. The UI shows
   the artifact crossing the WAN as a visually distinct transfer (packet
   train, byte count, digest), then the empty slot fills with a live
   analytics node. The card's code panel shows the agent's entire config —
   one entry string:

   ```js
   // the region agent, eu-west — this line IS the deployment
   { name: 'analytics_machine',
     entry: 'machinen+pull+http://127.0.0.1:3896?artifact=image' }
   ```

2. **`run report`** — the existing co-located run, unchanged
   (`/api/report/colocated`). It is disabled until beat 1 completes — which
   itself teaches: the host's entry exists in config, but the machine
   doesn't exist until the pull makes it exist.

Artifact choice is deliberate: **image, not snapshot**. Analytics is
stateless code; the image is the strict `remoteEntry.js` analog —
digest-pinned, immutable, cacheable. This balances the demo: page 01 act 04
teaches snapshot pull (warm fork, beyond MF), page 02 teaches image pull
(cold code-to-data, exactly MF). Both Phase 1 artifact kinds get a stage in
the context where each is the right tool.

**The anti-pattern, as text not buttons:** a short callout in the lesson
panel — *"why not pull `db_machine` here instead? Pull = clone. Three
consumers pulling the db get three databases that each believe they're the
real one — and the data would have moved, which is the thing gravity says
not to do. Attach to state you share; pull state you want to own."* This is
the design doc's blunt rule, taught at the moment the viewer is most likely
to ask the question.

**Comparison panel:** gains one annotation row (not a third bar — the bars
compare per-report latency; the pull is a different unit): *"one-time pull:
N KB in M ms — amortized over every report after."*

### The region agent

A new ~120-line process (`apps/host/src/region-agent.ts` or
`scripts/region-agent.mjs`), started by `demo-web.mjs` in the eu-west group:

- `machinenPlugin({ driver: processDriver({ env: { MACHINEN_REMOTE_DB_MACHINE: localEntry('db_machine') } }) })`
  — the clone's own db binding re-resolves to the **local** db address at
  boot. This is itself a teaching point surfaced in the wire trace: *"the
  clone's outbound federation entries re-resolved in its new region."*
  (`buildGuestEnv` already passes `MACHINEN_*` through to spawned guests.)
- Control API: `POST /deploy` → `registerRemotes` + `warm()` (warm
  pre-pulls per Phase 1), replies `{ bytes, digest, cacheHit, pullMs,
  bootMs }` from its own artifact hooks; `GET /status`.
- Boots the clone on **port 3805** — the port the pre-deployed analytics
  used — so the existing WAN link (3898 → 3805) routes to it with zero
  proxy changes and the host's analytics entry is untouched.
- Wipes its artifact cache on start so the first deploy of every demo run
  is honestly a miss.

Port plan (extends `scripts/machines.mjs`, the single source of truth):

| port | what |
| --- | --- |
| 3806 | analytics **origin** (moves off 3805; runs in us-east, serves `/mf-image` via the Phase 1 guest) |
| 3810 | region agent control API (eu-west) |
| 3897 | WAN link: host → agent control (deploy command crosses the WAN once) |
| 3896 | WAN link: agent → analytics origin (the artifact transfer pays WAN latency, visibly) |

The origin is a *running guest* rather than a static registry dir because
that uses only Phase 1 machinery (every machine serves its own artifacts) —
no bespoke manifest baking. The lesson text notes that a static dir / CDN
serves the identical layout; building that registry shape is Phase 2/3
work and explicitly out of scope here.

Effort: agent M, gravity card rework M, orchestration + smoke S.

## 5. Topology map spec

Both pages, shared mechanics (CSS-only — keep today's `tedge`/pulse system,
no canvas/SVG rewrite):

**Edge taxonomy** via `data-kind`:

| kind | rendering | when it animates |
| --- | --- | --- |
| `rpc` | thin dashed line, single colored pulse dot (today's style) | per call, from `afterCall` wire events |
| `artifact` | thicker line, packet-*train* animation, label `N KB · sha256:ab12… · hit\|miss` | during pull, from `beforeArtifactFetch`/`onArtifactFetched`; persists dimmed afterward as provenance ("this clone came from there") |
| `wan` | red crawl (today's gravity style) | continuous; busier while crossing |

**New nodes:**

- **Artifact cache** — small sub-node under the host column:
  `cache · N artifacts`. Flashes green `hit` / orange `fetch` per resolver
  event. Counters accumulate server-side from hook events; no new plugin
  metrics API needed.
- **Clone nodes** — appear with the existing card-in animation when act 04
  forks (page 01: a "local machines — process driver" group under the host
  column hosting origin + clones) and when the gravity deploy fills the
  eu-west slot (page 02). Tooltip shows `spec.pulledFrom` — the provenance
  field `f768be8` already landed.
- **Empty slot** (page 02 only) — dashed placeholder in eu-west that the
  deploy fills.

`/api/dashboard` grows a `lifecycle` block (origin/clone status + counter
values) and a `cache` block (artifacts, hits, misses, bytes).

## 6. Verdicts on the brief's ideas

| idea | verdict | disposition |
| --- | --- | --- |
| "Pull this machine to me" card | **refine** | merged into act 04 as steps 4–5; origin is the Node reference guest (`snap_machine`), not `java_machine` — Phase 1 only guarantees artifact endpoints on the Node guest (Java/Python are conformance follow-ups). A JVM pull is a stretch goal once Java conformance lands. |
| …with visibly lower call latency | **reject on page 01** | the origin is already local, so there is no honest latency delta; the latency payoff belongs on page 02 where the WAN exists. Faking it would break the demo's honesty contract. |
| Fork-race (two clones, diverged counters) | **accept, merged** | act 04 step 5 + the three-counter row; no separate card. |
| Gravity tie-in (pull analytics into the data region live) | **accept** | §4 — the plan's centerpiece, image-pull flavored. |
| …or pull the db snapshot to us | **reject as UI, accept as text** | it's the anti-pattern; teach it as the lesson-panel callout, not a button. |
| Cache story (second pull instant) | **accept, merged** | act 04 step 5 (image HIT) + cache node + gravity's `cacheHit` field. MF analogy (share scope / CDN cache) stated in the step narrative. |
| Topology upgrades (edge types, cache node, dynamic clones) | **accept** | §5; load-bearing infrastructure for everything else. |
| Phase 2 teaser | **accept as one line** | act 04 footer with the honest costs (~2.5 GB, arch-bound, registry-shaped). No UI. |
| Merge snapshot + pull into a lifecycle arc | **accept** | §3.5; same machine, same stepper, one story. |
| Guided story vs card grid | **accept lightly** | renumber into acts 01–06 (§2); keep the grid. A scroll-narrative rebuild costs L and risks the existing polish for marginal teaching value. |
| *(own)* Entry-string before/after diffs | **add** | each pull surface shows the one-line config delta — the design doc's "only end-user-visible change" claim, made visceral. Effort S. |
| *(own)* `artifacts` capability badge on machine cards | **add** | dashboard cards show an `artifacts` chip when the manifest advertises the block — capability-as-presence, mirroring `remoteEntry`. Effort S. |

## 7. Complexity accounting

| | today | proposed |
| --- | --- | --- |
| page 01 sections | 9 (5 interactive) | 8 (4 interactive) |
| page 01 stepper steps | 3 | 5 |
| page 02 sections | 6 | 6 (+1 button, +1 annotation row) |
| pages | 2 | 2 |

Net: one section and one interactive card fewer, two steps and one button
more. Flat-to-lower, as briefed.

## 8. API surface: what Phase 1 provides vs. follow-ups

Provided by Phase 1 (status as of writing — the implementer commits
incrementally):

- `machinen+pull+http(s)://` entries, `?artifact=image|snapshot`,
  `?digest=`, `spec.pulledFrom` provenance — ✓ landed (`f768be8`).
- `manifest.artifacts` block + `ArtifactDescriptor` — ✓ landed (`f768be8`).
- Node reference guest `/mf-image` + `/mf-snapshot` — ✓ landed (`80f1d0f`).
  Both `snap_machine` (`apps/remote`) and `analytics_machine` use
  `createGuestRuntime` / `serveGuest`, so both get the endpoints for free.
- Resolver + sha256-addressed cache — ✓ landed (`9f3c40d`):
  `resolvePullEntry(spec, { cacheDir })` returns a `PullResolution`
  carrying `bytesFetched` and `fromCache`, exactly the fields the UI needs.
- Pull branch in `ensureMachine`, `warm()` pre-pull, and the
  `beforeArtifactFetch` / `onArtifactFetched` hooks — still in flight;
  **the entire UI data flow depends on the hook payload** (descriptor,
  bytes, cache hit/miss, duration). If the landed shape differs, the
  wire-capture adapter in `server.ts` is the only place that needs
  adjusting.

Demo-side follow-ups this plan needs (none block Phase 1):

1. Region agent process + two extra WAN links + analytics origin re-port
   (§4) — demo orchestration only.
2. Demo-scoped artifact cache dir wiped on lifecycle reset (§3.5) — the
   resolver's `cacheDir` option already supports this; the only open
   question is how `machinenPlugin` threads it through (plugin option vs
   per-entry), which the in-flight plugin commit will settle.
3. `demo-web.mjs --smoke` additions: lifecycle pull round-trip (boot →
   freeze → restore → pull → diverge) and gravity deploy → report.

Honesty notes to carry into copy: `/mf-snapshot` is `no-store`, so each
fork re-fetches state (tiny — show both fetches in the trace, don't hide
the second one); the protocol is deliberately unauthenticated and
loopback-bound — anyone who can reach a machine can take its code and
memory (one footnote in the lesson panel); app-state snapshots capture only
what `dehydrate()` covers.

## 9. Phased rollout

**Wave A — with Phase 1's plugin/guest landing (no new processes).**
Page 01: lifecycle arc (steps 4–5, three counters, lineage strip), cut
compute playground, act renumbering, topology edge taxonomy + cache node +
clone nodes, `artifact` wire events, hero touch-up, capability badges.
~1–2 days. Ships the fork-by-fetch story the moment the capability exists.

**Wave B — gravity deploy-by-pull (new demo infra, still Phase 1
capability).** Region agent, WAN links 3896/3897, analytics origin on 3806,
scenario 2 rework, comparison annotation, anti-pattern callout, smoke
checks. ~2 days. Can land independently of Wave A but reads best after it.

**Wave C — Phase 2 alignment (when vmstate lands).** Keep the teaser as
text until then. When Phase 2 ships: the act 04 footer links the real
pull-restore CLI leg, and the gravity lesson gains the registry framing
(publish step → static dir → pull), still without new cards. Re-evaluate
then whether a registry node belongs on the gravity map; do not build it
speculatively.

## 10. Top three recommendations

1. **Merge, don't add:** one five-step lifecycle card (boot → freeze →
   restore → fork → fork-again) and one cut card keeps page 01 simpler than
   it is today while teaching the entire snapshot-pull capability.
2. **Make gravity's scenario 2 a deployment you watch:** the region agent +
   image pull turns the repo's best sentence — "topology is a config
   change" — from lesson text into a button. This is the demo's headline.
3. **Spend the UI budget on the topology map, fed only by real hooks:**
   edge taxonomy (rpc/artifact/wan), the cache node, and dynamic clone
   nodes are what make artifact movement *visible* — and they are reused by
   both pages, so the per-card cost stays small.
