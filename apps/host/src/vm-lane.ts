import { readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createInstance } from '@module-federation/runtime';
import {
  machinenDriver,
  machinenPlugin,
  type MachinenPlugin,
  type VmstateShellIdentity,
} from '@federated-compute/machinen-plugin';
import { logEvent } from './dashboard.js';
import { HttpError, errorMessage, json } from './http-util.js';
import { detectVmCapability, type VmCapability } from './vm-capability.js';
import { recordWire, wire, type WireEvent } from './wire.js';

// ---- whole-VM lane: ship the running process --------------------------------
// Phase 2 of the lifecycle story. The app-state arc (lifecycle.ts) needed the
// guest to cooperate (dehydrate/rehydrate). This lane moves a microVM's WHOLE
// state — heap, RNG, timers, kernel — through plugin.publishMachine() and a
// `machinen+pull+…?artifact=vmstate` entry. The solver's progress is
// deliberately NOT covered by dehydrate(): only this lane can move it.
//
// Two MF instances in this one process: `vmHost` is the producer (boots the
// source VM, owns `publish`), `vmPullHost` is the consumer ("second host",
// restores from the pulled artifact). Both use machinenDriver(); the native
// @machinen/runtime is loaded lazily by the driver itself on first boot, and
// every live route refuses with the capability detail first, so non-KVM hosts
// never touch it.

export const vmCapability: VmCapability = detectVmCapability();

const VM_NAME = 'vm_machine';
// 3814: the lifecycle arc's clone guests occupy 3812/3813 (LIFECYCLE_PORT+1/+2).
const VM_PUBLISH_PORT = Number(process.env.VM_PUBLISH_PORT ?? 3814);
// The lifecycle arc pulls its image over HTTP; this lane boots from the local
// bundle path because the producer IS the deployment here — the artifact that
// crosses a boundary in this story is the vmstate, not the image.
const VM_IMAGE = path.resolve(import.meta.dirname, '../../remote/dist/index.js');
// 1024 MiB: the same size the vmstate e2e pins — bundles land ~2.5 GB and the
// timings quoted in the UI stay comparable.
const VM_ENTRY = `machinen://${VM_IMAGE}?memory=1024`;
const VM_SNAP_DIR = path.resolve(import.meta.dirname, '../.machinen/web-vm-snapshots');
const VM_PUBLISH_DIR = path.resolve(import.meta.dirname, '../.machinen/web-vm-registry');
const VM_PULL_CACHE = path.resolve(import.meta.dirname, '../.machinen/web-vm-cache');
// Until the artifact-fetch/boot timeout split lands (runtime 2b), one budget
// covers pull + restore; 180s absorbs a multi-GB local transfer with margin.
const VM_BOOT_TIMEOUT_MS = 180_000;

// Inlined machine-module shape (server-side modules inline these rather than
// importing across apps — same pattern as CounterModule in server.ts).
interface SolverProgress {
  running: boolean;
  iteration: number;
  cacheSize: number;
  cacheCapacity: number;
  best: number;
  fingerprint: string;
  pid: number;
}

interface SolverModule {
  start(): Promise<SolverProgress>;
  stop(): Promise<SolverProgress>;
  progress(): Promise<SolverProgress>;
}

interface VmLaneState {
  phase: 'cold' | 'running' | 'published' | 'restored';
  busy: boolean;
  capability: VmCapability;
  /** Solver progress at the freeze point — the witness the restore must beat. */
  frozenAt?: SolverProgress;
  published?: {
    digest: string;
    bytes: number;
    url: string;
    publishMs: number;
    /**
     * Whether the dump stopped the source guest, observed by probing it.
     * Current x86_64/KVM runtime: true (despite docs calling checkpoints
     * non-destructive — pinned by the vmstate e2e). On a fixed engine the
     * source would survive and this reports false, honestly.
     */
    sourceDead: boolean;
    shell: VmstateShellIdentity;
  };
  pull?: { bytes: number; ms: number; cacheHit: boolean; digest?: string };
  /** The consumer's whole deployment story: one pull entry string. */
  entry?: string;
  timings: {
    bootMs?: number;
    publishMs?: number;
    /** Full pull + restore + first call (the warm bar of the race card). */
    restoreMs?: number;
  };
}

const vmLane: VmLaneState = { phase: 'cold', busy: false, capability: vmCapability, timings: {} };

let vmPlugin: MachinenPlugin | undefined;
let vmPullPlugin: MachinenPlugin | undefined;
let vmHost: ReturnType<typeof createInstance> | undefined;
let vmPullHost: ReturnType<typeof createInstance> | undefined;
let vmPullShellKey: string | undefined;

/**
 * Feed a vm plugin's hooks into the dashboard log — but NOT per-call events:
 * the UI polls solver progress at 500ms and per-call rows would wipe the
 * 200-entry activity ring. Pulls and crashes are the events that teach.
 * (cacheStats is deliberately untouched: that node tells the KB-scale
 * lifecycle cache story; the GB vmstate transfer gets its own rail.)
 */
function logVmHooks(p: MachinenPlugin): void {
  p.machineHooks.onArtifactFetched.on(({ spec, resolution }) => {
    logEvent(
      'pull',
      `${spec.remoteName} pulled ${resolution.artifact} from ${spec.url} — ` +
        (resolution.fromCache
          ? `cache HIT, ${resolution.bytesFetched} bytes moved`
          : `${resolution.bytesFetched} bytes fetched`) +
        ` in ${resolution.durationMs}ms`,
    );
  });
  p.machineHooks.onMachineCrash.on(({ spec }) => {
    logEvent('crash', `${spec.remoteName} (microVM) became unreachable`);
  });
}

function vmstateShellKey(shell: VmstateShellIdentity): string {
  return JSON.stringify(shell);
}

function ensureVmInstances(): void {
  if (vmPlugin) return;
  vmPlugin = machinenPlugin({
    driver: machinenDriver({ snapshotDir: VM_SNAP_DIR }),
    bootTimeoutMs: VM_BOOT_TIMEOUT_MS,
    publish: { dir: VM_PUBLISH_DIR, hostname: '127.0.0.1', port: VM_PUBLISH_PORT },
  });
  vmHost = createInstance({ name: 'vm_lane_host', remotes: [], plugins: [vmPlugin] });
  logVmHooks(vmPlugin);
  recordWire(vmPlugin);
}

async function ensureVmPullInstance(shell: VmstateShellIdentity): Promise<void> {
  const shellKey = vmstateShellKey(shell);
  if (vmPullPlugin && vmPullShellKey === shellKey) return;
  await vmPullPlugin?.disposeMachines();
  vmPullPlugin = machinenPlugin({
    driver: machinenDriver({ snapshotDir: VM_SNAP_DIR }),
    bootTimeoutMs: VM_BOOT_TIMEOUT_MS,
    artifactCacheDir: VM_PULL_CACHE,
    vmstateShell: shell,
  });
  vmPullHost = createInstance({ name: 'vm_pull_host', remotes: [], plugins: [vmPullPlugin] });
  vmPullShellKey = shellKey;
  logVmHooks(vmPullPlugin);
  recordWire(vmPullPlugin);
}

export function vmLaneBody() {
  const { busy: _busy, ...rest } = vmLane;
  return rest;
}

/** Serialize lane steps; refuse honestly when the hardware can't run them. */
async function vmStep<T extends Record<string, unknown>>(
  res: http.ServerResponse,
  allowed: VmLaneState['phase'][],
  step: () => Promise<T>,
): Promise<void> {
  if (!vmCapability.available) {
    return json(res, 503, {
      error: `live VM track unavailable: ${vmCapability.detail}`,
      capability: vmCapability,
    });
  }
  if (vmLane.busy) return json(res, 409, { error: 'a VM step is already running' });
  if (!allowed.includes(vmLane.phase)) {
    return json(res, 409, {
      error: `step not valid in phase "${vmLane.phase}" (expected ${allowed.join(' | ')})`,
    });
  }
  vmLane.busy = true;
  try {
    const extra = await step();
    json(res, 200, { ...vmLaneBody(), ...extra, wire: wire() });
  } finally {
    vmLane.busy = false;
  }
}

async function solverOn(host: NonNullable<typeof vmHost>): Promise<SolverModule> {
  const module = await host.loadRemote<SolverModule>(`${VM_NAME}/solver`);
  if (!module) throw new Error(`loadRemote("${VM_NAME}/solver") returned nothing`);
  return module;
}

/** GET /api/vm/state — phase + live solver progress when a VM is up. */
export async function handleVmState(_req: http.IncomingMessage, res: http.ServerResponse) {
  let progress: SolverProgress | undefined;
  try {
    // Skip the probe mid-step: loadRemote would block on an in-flight boot.
    if (!vmLane.busy && vmLane.phase === 'running') {
      progress = await (await solverOn(vmHost!)).progress();
    } else if (!vmLane.busy && vmLane.phase === 'restored') {
      progress = await (await solverOn(vmPullHost!)).progress();
    }
  } catch {
    // VM mid-transition; the state body still answers.
  }
  json(res, 200, { ...vmLaneBody(), progress });
}

/** POST /api/vm/boot — boot the source microVM and start the solver. */
export async function handleVmBoot(_req: http.IncomingMessage, res: http.ServerResponse) {
  await vmStep(res, ['cold', 'running', 'published', 'restored'], async () => {
    ensureVmInstances();
    // Reset the arc: dispose any prior source/clone, wipe the pull cache and
    // the previous run's bundles so each full run is honestly a cold pull
    // (and a multi-GB registry never accumulates across runs).
    await vmPlugin!.disposeMachines();
    await vmPullPlugin?.disposeMachines();
    await rm(VM_PULL_CACHE, { recursive: true, force: true });
    await rm(VM_PUBLISH_DIR, { recursive: true, force: true });
    await rm(VM_SNAP_DIR, { recursive: true, force: true });
    vmLane.phase = 'cold';
    vmLane.frozenAt = undefined;
    vmLane.published = undefined;
    vmLane.pull = undefined;
    vmLane.entry = undefined;
    vmLane.timings = {};
    vmPullShellKey = undefined;
    vmHost!.registerRemotes([{ name: VM_NAME, entry: VM_ENTRY }], { force: true });
    const t0 = performance.now();
    const solver = await solverOn(vmHost!);
    const progress = await solver.start(); // first call boots the VM
    vmLane.timings.bootMs = Math.round(performance.now() - t0);
    vmLane.phase = 'running';
    logEvent(
      'ready',
      `${VM_NAME} booted as a real microVM in ${vmLane.timings.bootMs}ms — solver running (pid ${progress.pid})`,
    );
    return { progress };
  });
}

/** POST /api/vm/publish — freeze mid-flight, publish vmstate; the dump stops the source. */
export async function handleVmPublish(_req: http.IncomingMessage, res: http.ServerResponse) {
  await vmStep(res, ['running'], async () => {
    try {
      const solver = await solverOn(vmHost!);
      vmLane.frozenAt = await solver.progress(); // the witness, captured just before the dump
      const t0 = performance.now();
      // One verb: whole-VM snapshot + content-addressed publish + lazily
      // started loopback artifact endpoint.
      const published = await vmPlugin!.publishMachine(VM_NAME);
      const publishMs = Math.round(performance.now() - t0);
      // Honesty note: the current x86_64/KVM runtime kills the source guest at dump
      // time despite the API docs calling checkpoints non-destructive (pinned
      // by the vmstate e2e). PROBE the source rather than assert: the failed
      // call routes through the plugin's own crash machinery, which evicts
      // and disposes the dead handle. (Deliberately NOT disposeMachines():
      // that would also close the artifact endpoint the restore pulls from.)
      let sourceDead = false;
      try {
        await solver.progress();
      } catch {
        sourceDead = true;
      }
      vmLane.published = {
        digest: published.digest,
        bytes: published.bytes,
        url: published.url,
        publishMs,
        sourceDead,
        shell: published.compatibility.shell,
      };
      vmLane.timings.publishMs = publishMs;
      vmLane.phase = 'published';
      logEvent(
        'snapshot',
        `${VM_NAME} frozen mid-solve + published as vmstate (${published.digest.slice(0, 19)}…, ` +
          `${published.bytes} bytes) — ` +
          (sourceDead
            ? 'the dump stopped the source VM (current x86_64/KVM runtime)'
            : 'source VM survived the dump'),
      );
      return {};
    } catch (error) {
      // A failed dump may still have stopped the source (see honesty note):
      // drop to a coherent cold state rather than reporting 'running' for a
      // machine that may be dead.
      await vmPlugin?.disposeMachines().catch(() => {});
      vmLane.phase = 'cold';
      vmLane.frozenAt = undefined;
      throw error;
    }
  });
}

/** POST /api/vm/restore — pull the vmstate artifact, restore, prove continuity. */
export async function handleVmRestore(_req: http.IncomingMessage, res: http.ServerResponse) {
  await vmStep(res, ['published'], async () => {
    // The clone's whole deployment story is this one entry string.
    const entry = `machinen+pull+${vmLane.published!.url}?artifact=vmstate&version=^1.0.0`;
    await ensureVmPullInstance(vmLane.published!.shell);
    vmPullHost!.registerRemotes([{ name: VM_NAME, entry }], { force: true });
    const t0 = performance.now();
    const solver = await solverOn(vmPullHost!);
    const progress = await solver.progress(); // first call pulls + restores
    vmLane.timings.restoreMs = Math.round(performance.now() - t0);
    // The artifact wire event for THIS request carries the real pull stats.
    // No fallbacks: a vmstate pull without an artifact hook event is a bug.
    const pull = wire().find(
      (e): e is Extract<WireEvent, { type: 'artifact' }> =>
        e.type === 'artifact' && e.machine === VM_NAME,
    );
    if (!pull) throw new Error(`pull of "${VM_NAME}" produced no artifact hook event`);
    vmLane.pull = { bytes: pull.bytes, ms: pull.ms, cacheHit: pull.cacheHit, digest: pull.digest };
    vmLane.entry = entry;
    const frozen = vmLane.frozenAt!;
    if (progress.iteration < frozen.iteration || progress.cacheSize < frozen.cacheSize) {
      throw new HttpError(
        500,
        `restored VM lost heap: iteration ${progress.iteration} < frozen ${frozen.iteration}`,
      );
    }
    vmLane.phase = 'restored';
    logEvent(
      'restore',
      `${VM_NAME} restored from pulled vmstate — solver resumed at iteration ${progress.iteration} ` +
        `(frozen at ${frozen.iteration})`,
    );
    return { progress, entry };
  });
}

/** POST /api/vm/reset — tear the lane down and reclaim the multi-GB artifacts. */
export async function handleVmReset(_req: http.IncomingMessage, res: http.ServerResponse) {
  if (vmLane.busy) return json(res, 409, { error: 'a VM step is already running' });
  vmLane.busy = true;
  try {
    await vmPlugin?.disposeMachines();
    await vmPullPlugin?.disposeMachines();
    await rm(VM_PULL_CACHE, { recursive: true, force: true });
    await rm(VM_PUBLISH_DIR, { recursive: true, force: true });
    await rm(VM_SNAP_DIR, { recursive: true, force: true });
    vmLane.phase = 'cold';
    vmLane.frozenAt = undefined;
    vmLane.published = undefined;
    vmLane.pull = undefined;
    vmLane.entry = undefined;
    vmLane.timings = {};
    json(res, 200, vmLaneBody());
  } finally {
    vmLane.busy = false;
  }
}

// The committed replay fixture: a real KVM run of the routes above, recorded
// by scripts/capture-vm-trace.mjs. Read at request time from the package dir
// (sibling of dist/) — demo data with provenance fields, not a build artifact.
const VM_TRACE_PATH = path.resolve(import.meta.dirname, '../vm-trace.json');

/** GET /api/vm/replay — the recorded trace for hosts that can't run live. */
export async function handleVmReplay(_req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const trace = JSON.parse(await readFile(VM_TRACE_PATH, 'utf8')) as { format?: string };
    if (trace.format !== 'vm-demo-trace@1') throw new Error('unexpected trace format');
    json(res, 200, trace);
  } catch (error) {
    json(res, 404, { error: `no replay trace available: ${errorMessage(error)}` });
  }
}

/** Shutdown path: kill the VMs and reclaim the GB-scale artifacts on disk. */
export async function disposeVmLane(): Promise<void> {
  try {
    await vmPlugin?.disposeMachines();
    await vmPullPlugin?.disposeMachines();
    await rm(VM_PULL_CACHE, { recursive: true, force: true });
    await rm(VM_PUBLISH_DIR, { recursive: true, force: true });
    await rm(VM_SNAP_DIR, { recursive: true, force: true });
    vmPullShellKey = undefined;
  } catch (error) {
    console.error(`[host] vm lane teardown: ${errorMessage(error)}`);
  }
}
// ----------------------------------------------------------------------------
