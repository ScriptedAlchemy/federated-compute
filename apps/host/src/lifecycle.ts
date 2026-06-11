import { rm, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createInstance } from '@module-federation/runtime';
import { machinenPlugin, processDriver } from '@federated-compute/machinen-plugin';
import { cacheStats, logEvent, logHooks } from './dashboard.js';
import { HttpError, json, readBody } from './http-util.js';
import { recordWire, wire, type WireEvent } from './wire.js';

interface CounterModule {
  current(): Promise<number>;
  increment(): Promise<number>;
}

// ---- machine lifecycle story ------------------------------------------------
// The five machines above are attached deployments (httpAttachDriver), so the
// host can't freeze them. The lifecycle card boots its OWN machine from an
// image via the process driver — the same federation runtime shape, but the
// driver owns the process, so plugin.snapshotMachine() and restore-from-.snap
// work. The restored guest then serves /mf-manifest.json + /mf-image +
// /mf-snapshot (it is a registry of itself), so `machinen+pull+http://` entries
// can fork it: steps 4/5 pull warm clones over plain HTTP. The CLI versions of
// the legs: pnpm demo:snapshot (freeze/restore), pnpm demo:pull (fork-by-fetch);
// the real-VM variant (machinenDriver(), whole-microVM dumps) is pnpm demo:machinen.

const SNAP_DIR = path.resolve(import.meta.dirname, '../.machinen/web-snapshots');
// Demo-scoped artifact cache, wiped on every lifecycle reset so each full run
// honestly shows the image crossing the wire exactly once.
const PULL_CACHE_DIR = path.resolve(import.meta.dirname, '../.machinen/web-cache');
const SNAP_NAME = 'snap_machine';
// Fixed port so the pull entries below are static: the process driver honors
// ?port= on image entries, which makes the origin its own artifact registry
// at a known address.
const SNAP_PORT = Number(process.env.SNAPSHOT_PORT ?? 3811);
// 100% HTTP: the host never reads machine code from disk. The origin's image
// is PULLED from compute_machine's published /mf-image (the same bundle that
// deployment runs) into the digest cache, then booted from the host's own
// cache — code only ever moves between machines over HTTP. The default
// derives from compute_machine's entry so an address override
// (MACHINEN_REMOTE_COMPUTE_MACHINE) carries over automatically.
const ORIGIN_IMAGE_SOURCE =
  process.env.SNAPSHOT_IMAGE_SOURCE ??
  (process.env.MACHINEN_REMOTE_COMPUTE_MACHINE ?? 'machinen+http://127.0.0.1:3801?version=^1.0.0')
    .replace(/^machinen\+/, '')
    .split('?')[0];
const ORIGIN_ENTRY =
  `machinen+pull+${ORIGIN_IMAGE_SOURCE}?artifact=image&port=${SNAP_PORT}&version=^1.0.0`;

const CLONE_IDS = ['a', 'b'] as const;
type CloneId = (typeof CLONE_IDS)[number];
const cloneName = (id: CloneId) => `snap_clone_${id}`;
const clonePort = (id: CloneId) => SNAP_PORT + CLONE_IDS.indexOf(id) + 1;
// The whole deployment story of a clone is this one entry string. The clone=
// param only disambiguates the two forks: the runtime caches machines (and
// memoizes pull resolutions) per entry string, and two independent clones
// must not share one process.
const cloneEntry = (id: CloneId) =>
  `machinen+pull+http://127.0.0.1:${SNAP_PORT}?artifact=snapshot&port=${clonePort(id)}&version=^1.0.0&clone=${id}`;

export const snapPlugin = machinenPlugin({
  driver: processDriver({ snapshotDir: SNAP_DIR }),
  artifactCacheDir: PULL_CACHE_DIR,
});
const snapHost = createInstance({
  name: 'lifecycle_host',
  remotes: [{ name: SNAP_NAME, entry: ORIGIN_ENTRY }],
  plugins: [snapPlugin],
});
logHooks(snapPlugin);
recordWire(snapPlugin);

interface CloneState {
  /** Counter value the clone resumed at (the fork point). */
  resumed: number;
  /** Current counter value (diverges from the origin via /api/lifecycle/counter). */
  value: number;
  entry: string;
  pulledBytes: number;
  imageCacheHit: boolean;
  pullMs: number;
  /** Set when the entry pinned ?digest= and the resolver verified it (clone b). */
  pinnedDigest?: string;
}

interface LifecycleState {
  phase: 'cold' | 'running' | 'snapshotted' | 'restored' | 'forked';
  value?: number;
  snapFile?: string;
  snapBytes?: number;
  clones: Partial<Record<CloneId, CloneState>>;
  busy: boolean;
  /**
   * The image digest learned from the step-4 pull (the booted clone's
   * manifest advertises the artifact it runs). Step 5 pins its entry to it.
   */
  imageDigest?: string;
}

const lifecycle: LifecycleState = { phase: 'cold', clones: {}, busy: false };

export function lifecycleBody() {
  const { busy: _busy, snapFile, ...rest } = lifecycle;
  return {
    ...rest,
    snapFile: snapFile ? path.basename(snapFile) : undefined,
    originPort: SNAP_PORT,
  };
}

/** Serialize the lifecycle arc: one step at a time, valid phases only. */
async function lifecycleStep<T>(
  res: http.ServerResponse,
  allowed: LifecycleState['phase'][],
  step: () => Promise<T>,
): Promise<void> {
  if (lifecycle.busy) return json(res, 409, { error: 'a lifecycle step is already running' });
  if (!allowed.includes(lifecycle.phase)) {
    return json(res, 409, {
      error: `step not valid in phase "${lifecycle.phase}" (expected ${allowed.join(' | ')})`,
    });
  }
  lifecycle.busy = true;
  try {
    const extra = await step();
    json(res, 200, { ...lifecycleBody(), ...extra, wire: wire() });
  } finally {
    lifecycle.busy = false;
  }
}

/** Step 1 — boot & work. Also the arc's reset: clones, origin, cache all go. */
export async function handleLifecycleBoot(_req: http.IncomingMessage, res: http.ServerResponse) {
  await lifecycleStep(res, ['cold', 'running', 'snapshotted', 'restored', 'forked'], async () => {
    // Full reset: kill origin + clones, wipe the artifact cache so the boot
    // pull is honestly a miss, then (re)point the remote at the pull entry —
    // a normal dynamic-remotes operation; force drops the cached container
    // for the name. The image arrives over HTTP from compute_machine's
    // /mf-image and boots from the host's own digest cache.
    await snapPlugin.disposeMachines();
    await rm(PULL_CACHE_DIR, { recursive: true, force: true });
    cacheStats.reset();
    // The reset is destructive and the pull below can fail (compute_machine
    // is the chaos victim — it may be mid-respawn). Drop to a coherent cold
    // state FIRST so a failed boot never reports a phase whose invariants
    // (clones, processes, cache) were just wiped.
    lifecycle.phase = 'cold';
    lifecycle.value = undefined;
    lifecycle.snapFile = undefined;
    lifecycle.snapBytes = undefined;
    lifecycle.clones = {};
    lifecycle.imageDigest = undefined;
    snapHost.registerRemotes([{ name: SNAP_NAME, entry: ORIGIN_ENTRY }], { force: true });
    const counter = (await snapHost.loadRemote<CounterModule>(`${SNAP_NAME}/counter`))!;
    await counter.increment();
    await counter.increment();
    lifecycle.value = await counter.increment();
    lifecycle.phase = 'running';
    return { loadRemote: `${SNAP_NAME}/counter` };
  });
}

/** Step 2 — freeze the machine's app state into a .snap bundle, then kill the process. */
export async function handleLifecycleFreeze(_req: http.IncomingMessage, res: http.ServerResponse) {
  await lifecycleStep(res, ['running'], async () => {
    const snapshot = (await snapPlugin.snapshotMachine(SNAP_NAME)) as { snapFile: string };
    await snapPlugin.disposeMachines(); // the process is gone — state lives only in the bundle
    logEvent('snapshot', `${SNAP_NAME} process killed — state lives in the .snap bundle`);
    lifecycle.phase = 'snapshotted';
    lifecycle.snapFile = snapshot.snapFile;
    lifecycle.snapBytes = (await stat(snapshot.snapFile)).size;
    return {};
  });
}

/** Step 3 — restore: point the SAME remote name at the .snap and loadRemote again. */
export async function handleLifecycleRestore(_req: http.IncomingMessage, res: http.ServerResponse) {
  await lifecycleStep(res, ['snapshotted'], async () => {
    // Same fixed port: the restored process is the pull origin for steps 4/5.
    snapHost.registerRemotes(
      [{ name: SNAP_NAME, entry: `machinen://${lifecycle.snapFile}?port=${SNAP_PORT}` }],
      { force: true },
    );
    const counter = (await snapHost.loadRemote<CounterModule>(`${SNAP_NAME}/counter`))!;
    const resumed = await counter.current();
    const next = await counter.increment();
    logEvent('restore', `${SNAP_NAME} restored from .snap — counter resumed at ${resumed}`);
    lifecycle.phase = 'restored';
    lifecycle.value = next;
    return { resumed, next, loadRemote: `${SNAP_NAME}/counter` };
  });
}

/** Steps 4/5 — fork by pull: register a pull entry against the origin, loadRemote. */
export async function handleLifecyclePull(_req: http.IncomingMessage, res: http.ServerResponse) {
  await lifecycleStep(res, ['restored', 'forked'], async () => {
    const id = CLONE_IDS.find((c) => !lifecycle.clones[c]);
    if (!id) throw new HttpError(409, 'both clones already exist — step 1 resets the arc');
    const name = cloneName(id);
    // Step 5 demonstrates ?digest= pinning: clone b's entry pins the image
    // digest learned from the step-4 pull, so the resolver refuses to boot
    // anything but exactly that code. Honest-data rule: if step 4 somehow
    // didn't learn a digest, fail loudly — the UI must never claim a pin
    // that doesn't exist.
    if (id === 'b' && !lifecycle.imageDigest) {
      throw new Error('step 4 recorded no image digest — cannot pin clone b');
    }
    const pin = id === 'b' ? lifecycle.imageDigest : undefined;
    const entry = cloneEntry(id) + (pin ? `&digest=${pin}` : '');
    // force: after a reset the MF runtime may still cache the previous
    // clone's container under this name.
    snapHost.registerRemotes([{ name, entry }], { force: true });
    const counter = (await snapHost.loadRemote<CounterModule>(`${name}/counter`))!;
    const resumed = await counter.current();
    // The artifact hook events for THIS request carry the real pull stats.
    // No fallbacks: fabricating "0 bytes · MISS" would violate the demo's
    // honest-data rule, and a pull without an artifact event is a real bug.
    const pull = wire().find(
      (e): e is Extract<WireEvent, { type: 'artifact' }> =>
        e.type === 'artifact' && e.machine === name,
    );
    if (!pull) throw new Error(`pull of "${name}" produced no artifact hook event`);
    // The booted clone's own manifest advertises the image it runs — that
    // digest (real hook data) is what step 5 will pin.
    const ready = wire().find(
      (e): e is Extract<WireEvent, { type: 'attach' }> =>
        e.type === 'attach' && e.machine === name,
    );
    if (ready?.imageDigest) lifecycle.imageDigest = ready.imageDigest;
    lifecycle.clones[id] = {
      resumed,
      value: resumed,
      entry,
      pulledBytes: pull.bytes,
      imageCacheHit: pull.cacheHit,
      pullMs: pull.ms,
      pinnedDigest: pin,
    };
    lifecycle.phase = 'forked';
    return { clone: id, resumed, loadRemote: `${name}/counter` };
  });
}

type CounterTarget = 'origin' | CloneId;

function isCounterTarget(value: unknown): value is CounterTarget {
  return value === 'origin' || value === 'a' || value === 'b';
}

/** Increment one of the three counters — origin and clones diverge from here. */
export async function handleLifecycleCounter(req: http.IncomingMessage, res: http.ServerResponse) {
  const { target } = await readBody(req);
  if (!isCounterTarget(target)) {
    return json(res, 400, { error: `expected target: origin | a | b, got "${String(target)}"` });
  }
  if (lifecycle.busy) return json(res, 409, { error: 'a lifecycle step is already running' });
  let remote: string;
  switch (target) {
    case 'origin': {
      if (!['running', 'restored', 'forked'].includes(lifecycle.phase)) {
        return json(res, 409, { error: `origin is not running (phase "${lifecycle.phase}")` });
      }
      remote = SNAP_NAME;
      break;
    }
    case 'a':
    case 'b': {
      if (!lifecycle.clones[target]) {
        return json(res, 409, { error: `clone ${target} does not exist yet` });
      }
      remote = cloneName(target);
      break;
    }
    default: {
      const unreachable: never = target;
      return json(res, 400, { error: `unknown target ${String(unreachable)}` });
    }
  }
  const counter = (await snapHost.loadRemote<CounterModule>(`${remote}/counter`))!;
  const value = await counter.increment();
  if (target === 'origin') lifecycle.value = value;
  else lifecycle.clones[target]!.value = value;
  // `targetValue`, not `value`: lifecycleBody() already carries the origin's
  // counter under `value` and must not be shadowed.
  json(res, 200, {
    ...lifecycleBody(),
    target,
    targetValue: value,
    loadRemote: `${remote}/counter`,
    wire: wire(),
  });
}
// ----------------------------------------------------------------------------
