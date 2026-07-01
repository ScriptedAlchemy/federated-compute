import { rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createInstance } from '@module-federation/runtime';
import {
  formatShell,
  machinenDriver,
  machinenPlugin,
  type MachinenPlugin,
  type PublishedMachine,
  type VmstateShellIdentity,
} from '@federated-compute/machinen-plugin';
import type { ComputeMachineFluid } from './generated/compute_machine';
import { HttpError, json, readBody } from './http-util.js';
import { refuseWithoutVmCapability } from './vm-lane.js';
import { recordWire, wire } from './wire.js';
import {
  decideFluidPlacement,
  fluidTimeline,
  simulateAdaptiveFluidTraffic,
  type FluidDecision,
  type FluidPolicy,
} from './fluid-compute.js';

// ---- fluid compute lane ------------------------------------------------------
// The fluid demo's placement story: a query either runs at the origin machine
// (local mode, through the main host instance) or on a restored microVM clone
// pulled from a published vmstate snapshot (colocate/distribute modes). Two MF
// instances back the VM path: `fluidSourceHost` boots the seed VM and owns
// `publish`; `fluidRestoreHost` is the consumer that restores from the pulled
// artifact — the same producer/consumer split as vm-lane.ts.

type FluidModule = ComputeMachineFluid;

const FLUID_ORIGIN_REMOTE = 'compute_machine';
const FLUID_SEED_REMOTE = 'fluid_seed';
const FLUID_SEED_IMAGE = path.resolve(import.meta.dirname, '../../remote/dist/index.js');
const FLUID_SEED_ENTRY = `machinen://${FLUID_SEED_IMAGE}?memory=1024`;
const FLUID_VM_SNAP_DIR = path.resolve(import.meta.dirname, '../.machinen/fluid-vm-snapshots');
const FLUID_VM_PUBLISH_DIR = path.resolve(import.meta.dirname, '../.machinen/fluid-vm-registry');
const FLUID_VM_PULL_CACHE = path.resolve(import.meta.dirname, '../.machinen/fluid-vm-cache');
const FLUID_PUBLISH_PORT = Number(process.env.FLUID_PUBLISH_PORT ?? 3816);
const FLUID_BOOT_TIMEOUT_MS = 180_000;

let fluidSourcePlugin: MachinenPlugin | undefined;
let fluidRestorePlugin: MachinenPlugin | undefined;
let fluidSourceHost: ReturnType<typeof createInstance> | undefined;
let fluidRestoreHost: ReturnType<typeof createInstance> | undefined;
let fluidRestoreShellKey: string | undefined;

interface FluidPrepared {
  phase: 'prepared';
  published: PublishedMachine;
  timings: { bootMs: number; publishMs: number };
  sourceDead: boolean;
}

let fluidPrepared: FluidPrepared | undefined;
let fluidRestoreCount = 0;
// Serializes the VM-touching steps (prepare, non-local query): the lane's
// module singletons are shared state, and two concurrent restores would
// disposeMachines() each other's VM mid-call. Same pattern as vm-lane's
// vmStep() busy flag.
let fluidBusy = false;

function refuseWhenFluidBusy(res: http.ServerResponse): boolean {
  if (!fluidBusy) return false;
  json(res, 409, { error: 'a fluid step is already running' });
  return true;
}

function regionSlug(region: string): string {
  return region.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'region';
}

function ensureFluidSourceInstance(): void {
  if (fluidSourcePlugin) return;
  fluidSourcePlugin = machinenPlugin({
    driver: machinenDriver({ snapshotDir: FLUID_VM_SNAP_DIR }),
    bootTimeoutMs: FLUID_BOOT_TIMEOUT_MS,
    publish: { dir: FLUID_VM_PUBLISH_DIR, hostname: '127.0.0.1', port: FLUID_PUBLISH_PORT },
  });
  fluidSourceHost = createInstance({
    name: 'fluid_ci_host',
    remotes: [],
    plugins: [fluidSourcePlugin],
  });
  recordWire(fluidSourcePlugin);
}

async function ensureFluidRestoreInstance(shell: VmstateShellIdentity): Promise<void> {
  const shellKey = formatShell(shell);
  if (fluidRestorePlugin && fluidRestoreShellKey === shellKey) return;
  await fluidRestorePlugin?.disposeMachines();
  fluidRestorePlugin = machinenPlugin({
    driver: machinenDriver({ snapshotDir: FLUID_VM_SNAP_DIR }),
    bootTimeoutMs: FLUID_BOOT_TIMEOUT_MS,
    artifactCacheDir: FLUID_VM_PULL_CACHE,
    vmstateShell: shell,
  });
  fluidRestoreHost = createInstance({
    name: 'fluid_restore_host',
    remotes: [],
    plugins: [fluidRestorePlugin],
  });
  fluidRestoreShellKey = shellKey;
  recordWire(fluidRestorePlugin);
}

async function resetFluidPreparedState(): Promise<void> {
  // The plugin/host pairs survive the reset: createInstance() appends to
  // Module Federation's process-global instance registry with no removal
  // API, so re-creating them here would grow that registry on every reset.
  // disposeMachines() already clears everything that must not leak across
  // runs (VMs, the publish endpoint, memoized pull resolutions), and each
  // prepare/restore re-registers its remote with force:true. The restore
  // plugin is still rebuilt by ensureFluidRestoreInstance() when the
  // published shell identity changes — vmstateShell is a construction-time
  // option — which is the one unavoidable createInstance() repeat.
  await Promise.allSettled([
    fluidSourcePlugin?.disposeMachines(),
    fluidRestorePlugin?.disposeMachines(),
  ]);
  fluidPrepared = undefined;
  fluidRestoreCount = 0;
  await Promise.all([
    rm(FLUID_VM_SNAP_DIR, { recursive: true, force: true }),
    rm(FLUID_VM_PUBLISH_DIR, { recursive: true, force: true }),
    rm(FLUID_VM_PULL_CACHE, { recursive: true, force: true }),
  ]);
}

async function fluidModuleOn(
  targetHost: ReturnType<typeof createInstance>,
  remoteName: string,
): Promise<FluidModule> {
  const module = await targetHost.loadRemote<FluidModule>(`${remoteName}/fluid`);
  if (!module) throw new Error(`loadRemote("${remoteName}/fluid") returned nothing`);
  return module;
}

async function prepareFluidSnapshot({ reset = false } = {}): Promise<FluidPrepared> {
  if (fluidPrepared && !reset) return fluidPrepared;
  if (reset) await resetFluidPreparedState();
  ensureFluidSourceInstance();
  fluidSourceHost!.registerRemotes([{ name: FLUID_SEED_REMOTE, entry: FLUID_SEED_ENTRY }], {
    force: true,
  });
  const bootStart = performance.now();
  const fluid = await fluidModuleOn(fluidSourceHost!, FLUID_SEED_REMOTE);
  await fluid.compute('warm fluid compute module for snapshot restore', 'fluid_seed@ci');
  const bootMs = Math.round(performance.now() - bootStart);
  const publishStart = performance.now();
  const published = await fluidSourcePlugin!.publishMachine(FLUID_SEED_REMOTE);
  const publishMs = Math.round(performance.now() - publishStart);
  let sourceDead = false;
  try {
    await fluid.inbox();
  } catch {
    sourceDead = true;
  }
  fluidPrepared = {
    phase: 'prepared',
    published,
    timings: { bootMs, publishMs },
    sourceDead,
  };
  return fluidPrepared;
}

function fluidRestoreRemoteFor(
  prepared: FluidPrepared,
  decision: FluidDecision,
): { name: string; entry: string } {
  const slug = regionSlug(decision.executionRegion);
  const name = `fluid_restore_${slug}_${++fluidRestoreCount}`;
  const params = new URLSearchParams({
    artifact: 'vmstate',
    version: '^1.0.0',
    digest: prepared.published.digest,
  });
  const entry = `machinen+pull+${prepared.published.url}?${params.toString()}`;
  return { name, entry };
}

/**
 * POST /api/fluid/prepare — boot the seed VM, warm it, publish its vmstate.
 * The prepare/restore paths boot real machinenDriver VMs — same hardware
 * requirements as the vm lane, same honest 503 when they are absent.
 */
export async function handleFluidPrepare(req: http.IncomingMessage, res: http.ServerResponse) {
  if (refuseWithoutVmCapability(res)) return;
  const body = await readBody(req);
  const reset = body.reset !== false;
  if (refuseWhenFluidBusy(res)) return;
  fluidBusy = true;
  try {
    const prepared = await prepareFluidSnapshot({ reset });
    json(res, 200, { ...prepared, wire: wire() });
  } finally {
    fluidBusy = false;
  }
}

/**
 * POST /api/fluid/query — place a query (decideFluidPlacement) and run it,
 * either at the origin machine on the main host (local mode) or on a microVM
 * restored from the prepared vmstate snapshot.
 */
export async function handleFluidQuery(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  originHost: ReturnType<typeof createInstance>,
) {
  const body = await readBody(req);
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) return json(res, 400, { error: 'expected { query: string }' });
  const rawPolicy = typeof body.policy === 'string' ? body.policy : 'auto';
  const policy: FluidPolicy =
    rawPolicy === 'local' || rawPolicy === 'colocate' || rawPolicy === 'distribute'
      ? rawPolicy
      : 'auto';
  const callerRegion = typeof body.callerRegion === 'string' && body.callerRegion.trim()
    ? body.callerRegion.trim()
    : 'us-east';
  const preparedShell = fluidPrepared?.published.compatibility.shell;
  const preparedShellKey = preparedShell ? formatShell(preparedShell) : undefined;

  const decision = decideFluidPlacement({
    policy,
    payloadBytes: Buffer.byteLength(query),
    callerRegion,
    originRegion: 'us-east',
    dataRegion: 'eu-west',
    ...(preparedShellKey
      ? {
          requiredShell: preparedShellKey,
          regions: ['us-east', 'eu-west', 'ap-south'].map((region) => ({
            region,
            canRestoreVmstate: true,
            shell: preparedShellKey,
          })),
        }
      : {}),
  });
  // Only the restore path touches the lane's shared VM singletons; local
  // queries run against the main host and stay concurrent.
  const needsRestoreVm = decision.mode !== 'local';
  if (needsRestoreVm) {
    if (refuseWithoutVmCapability(res)) return;
    if (refuseWhenFluidBusy(res)) return;
    fluidBusy = true;
  }
  try {
    const start = performance.now();
    let remoteName = FLUID_ORIGIN_REMOTE;
    let workerModule = `${remoteName}/fluid`;
    let restore:
      | { artifact: 'vmstate'; entry: string; bytes: number; ms: number; cacheHit: boolean; digest?: string }
      | undefined;
    let restoreEntry: string | undefined;
    let workerHost: ReturnType<typeof createInstance> = originHost;
    if (needsRestoreVm) {
      if (!fluidPrepared) {
        throw new HttpError(409, 'fluid snapshot is not prepared — POST /api/fluid/prepare first');
      }
      const prepared = fluidPrepared;
      const remote = fluidRestoreRemoteFor(prepared, decision);
      await ensureFluidRestoreInstance(prepared.published.compatibility.shell);
      await fluidRestorePlugin!.disposeMachines();
      remoteName = remote.name;
      workerModule = `${remote.name}/fluid`;
      restoreEntry = remote.entry;
      fluidRestoreHost!.registerRemotes([{ name: remote.name, entry: remote.entry }], { force: true });
      workerHost = fluidRestoreHost!;
    }
    const worker = await fluidModuleOn(workerHost, remoteName);
    const origin = await fluidModuleOn(originHost, FLUID_ORIGIN_REMOTE);
    const computed = await worker.compute(query, decision.replica);
    const backhaul = await origin.acceptBackhaul(decision.connection.from, computed.chunk);
    if (needsRestoreVm) {
      const pull = wire().find(
        (event) => event.type === 'artifact' && event.machine === remoteName && event.artifact === 'vmstate',
      );
      if (!pull || pull.type !== 'artifact') {
        throw new Error(`restore of "${remoteName}" produced no vmstate artifact hook event`);
      }
      if (!restoreEntry) throw new Error(`restore of "${remoteName}" has no pull entry`);
      restore = {
        artifact: 'vmstate',
        entry: restoreEntry,
        bytes: pull.bytes,
        ms: pull.ms,
        cacheHit: pull.cacheHit,
        digest: pull.digest,
      };
    }

    json(res, 200, {
      module: workerModule,
      originModule: `${FLUID_ORIGIN_REMOTE}/fluid`,
      remote: remoteName,
      decision,
      prepared: fluidPrepared ?? null,
      restore,
      timeline: fluidTimeline(decision),
      result: {
        computed,
        backhaul,
        answer: `${computed.chunk} (${computed.words} words)`,
      },
      totalMs: performance.now() - start,
      wire: wire(),
    });
  } finally {
    if (needsRestoreVm) fluidBusy = false;
  }
}

/** POST /api/fluid/adapt — the supplementary adaptive-traffic simulation. */
export async function handleFluidAdapt(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await readBody(req);
  const requestCount = typeof body.requestCount === 'number' ? body.requestCount : undefined;
  const hotRegion = typeof body.hotRegion === 'string' && body.hotRegion.trim()
    ? body.hotRegion.trim()
    : undefined;
  const burst = simulateAdaptiveFluidTraffic({ requestCount, hotRegion });
  json(res, 200, {
    ...burst,
    description:
      'supplementary simulation: repeated traffic pays a one-time vmstate restore cost, then later calls run closer',
  });
}

/** Shutdown path: kill the lane's VMs (they are children of this process). */
export async function disposeFluidLane(): Promise<void> {
  await Promise.allSettled([
    fluidSourcePlugin?.disposeMachines(),
    fluidRestorePlugin?.disposeMachines(),
  ]);
}
// ----------------------------------------------------------------------------
