// Interactive demo backend. The host is a stock Module Federation runtime
// consumer — createInstance({ remotes, plugins }) + host.loadRemote(...) —
// exactly the shape from module-federation.io, except the remotes are
// machines: the machinen plugin claims machinen entries and turns them into
// containers of typed async function proxies.
//
// IMPORTANT for readers: federation happens HERE, in this Node process. The
// browser only ever does plain fetch('/api/...'); every loadRemote below runs
// server-side, and every machine call is an HTTP RPC (POST /mf/call) from
// this process into the machine. The /api responses include a `wire` array —
// real data captured from the plugin's hooks — so the UI can show exactly
// what crossed which boundary.
import { once } from 'node:events';
import { readFile, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createInstance } from '@module-federation/runtime';
import {
  DEFAULT_POLICY,
  MachineVersionError,
  httpAttachDriver,
  machinenDriver,
  machinenPlugin,
  parseMachineEntry,
  type MachinenPlugin,
  type MachineDriver,
  type MachineSpec,
  type PublishedMachine,
  type VmstateShellIdentity,
} from '@federated-compute/machinen-plugin';
import {
  androidVncPort,
  disposeAndroidLab,
  handleAndroidBoot,
  handleAndroidFreeze,
  handleAndroidLaunch,
  handleAndroidReset,
  handleAndroidResume,
  handleAndroidStatus,
} from './android-demo.js';
import { handleDashboard, logHooks, machineStatus } from './dashboard.js';
import type { ComputeMachineFluid, ComputeMachineModules } from './generated/compute_machine';
import type { JavaMachineModules } from './generated/java_machine';
import type { PythonMachineModules } from './generated/python_machine';
import type { DbMachineModules } from './generated/db_machine';
import type { AnalyticsMachineModules } from './generated/analytics_machine';
import { HttpError, errorMessage, errorName, json, readBody, serveStatic } from './http-util.js';
import {
  handleLifecycleBoot,
  handleLifecycleCounter,
  handleLifecycleFreeze,
  handleLifecyclePull,
  handleLifecycleRestore,
  lifecycleBody,
  snapPlugin,
} from './lifecycle.js';
import {
  disposeVmLane,
  handleVmBoot,
  handleVmPublish,
  handleVmReplay,
  handleVmReset,
  handleVmRestore,
  handleVmState,
  vmCapability,
  vmLaneBody,
} from './vm-lane.js';
import { recordWire, wire, wireStore } from './wire.js';
import {
  decideFluidPlacement,
  fluidTimeline,
  simulateAdaptiveFluidTraffic,
  type FluidDecision,
  type FluidPolicy,
} from './fluid-compute.js';

const PORT = Number(process.env.HOST_PORT ?? 3800);
// All simulated WAN links into the data region (db + analytics paths).
const REGION_LINKS = (process.env.REGION_LINKS ?? 'http://127.0.0.1:3899,http://127.0.0.1:3898')
  .split(',')
  .map((s) => s.trim());

// The demo topology: three compute machines next to the host, two data
// machines in a far region (reached through the WAN links above).
const MACHINES = [
  { name: 'compute_machine', port: 3801, region: 'us-east' },
  { name: 'java_machine', port: 3802, region: 'us-east' },
  { name: 'python_machine', port: 3803, region: 'us-east' },
  { name: 'db_machine', port: 3804, region: 'eu-west' },
  { name: 'analytics_machine', port: 3805, region: 'eu-west' },
] as const;

const JAVA_VM_IMAGE_ENTRY = `machinen://${path.resolve(
  import.meta.dirname,
  '../../remote-java/dist/java_machine.machine',
)}?memory=2048&version=^1.0.0`;

/** Machine entry: deploy-time env override, optional Java VM, or the dev-loop default port. */
function entryFor(name: string, port: number): string {
  if (name === 'java_machine' && process.env.MACHINEN_JAVA_VM === '1') {
    return process.env.MACHINEN_REMOTE_JAVA_MACHINE ?? JAVA_VM_IMAGE_ENTRY;
  }
  return (
    process.env[`MACHINEN_REMOTE_${name.toUpperCase()}`] ??
    `machinen+http://127.0.0.1:${port}?version=^1.0.0`
  );
}

const remotes = MACHINES.map(({ name, port }) => ({ name, entry: entryFor(name, port) }));

function mixedDriver(): MachineDriver {
  const attach = httpAttachDriver();
  const vm = machinenDriver({
    snapshotDir: path.resolve(import.meta.dirname, '../.machinen/java-vm-snapshots'),
    bootTimeoutMs: 180_000,
  });
  return {
    boot(spec: MachineSpec) {
      return spec.kind === 'attach' ? attach.boot(spec) : vm.boot(spec);
    },
  };
}

// ---- the entire federation setup ------------------------------------------
const plugin = machinenPlugin({ driver: mixedDriver(), bootTimeoutMs: 180_000 });
const host = createInstance({
  name: 'host',
  remotes,
  plugins: [plugin],
});
// ----------------------------------------------------------------------------

for (const { name } of MACHINES) {
  machineStatus.set(name, { attached: false });
}
logHooks(plugin);
recordWire(plugin);

/** One request fanning out across three machines in three languages. */
async function handlePipeline(req: http.IncomingMessage, res: http.ServerResponse) {
  const { text: input } = await readBody(req);
  if (typeof input !== 'string' || !input.trim()) {
    return json(res, 400, { error: 'expected { text: string }' });
  }

  const totalStart = performance.now();

  // Each stage is one loadRemote + plain calls. The MF runtime caches
  // containers, so only the first request pays the attach.
  const javaStart = performance.now();
  const strings = (await host.loadRemote<JavaMachineModules['./strings']>('java_machine/strings'))!;
  const [digest, upper] = await Promise.all([strings.sha256(input), strings.upper(input)]);
  const javaMs = performance.now() - javaStart;

  const pyStart = performance.now();
  const data = (await host.loadRemote<PythonMachineModules['./data']>('python_machine/data'))!;
  const stats = (await host.loadRemote<PythonMachineModules['./stats']>('python_machine/stats'))!;
  const wordCount = await data.wordCount(input);
  const lengths = Object.keys(wordCount).map((w) => w.length);
  const [meanLen, medianLen] = lengths.length
    ? await Promise.all([stats.mean(lengths), stats.median(lengths)])
    : [0, 0];
  const pyMs = performance.now() - pyStart;

  const nodeStart = performance.now();
  const text = (await host.loadRemote<ComputeMachineModules['./text']>('compute_machine/text'))!;
  const [shouted, reversed] = await Promise.all([text.shout(input), text.reverse(input)]);
  const nodeMs = performance.now() - nodeStart;

  json(res, 200, {
    java: { sha256: digest, upper, ms: javaMs, remote: 'java_machine/strings' },
    python: {
      wordCount,
      meanWordLength: meanLen,
      medianWordLength: medianLen,
      ms: pyMs,
      remote: 'python_machine/data + /stats',
    },
    node: { shouted, reversed, ms: nodeMs, remote: 'compute_machine/text' },
    totalMs: performance.now() - totalStart,
    wire: wire(),
  });
}

/** Stream crossing two boundaries: machine -> host (NDJSON) -> browser (SSE). */
async function handleCountdown(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const from = Math.min(Math.max(Number(url.searchParams.get('from')) || 5, 1), 30);
  const math = (await host.loadRemote<ComputeMachineModules['./math']>('compute_machine/math'))!;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  // Respect backpressure: wait for 'drain' when the kernel buffer is full,
  // but stop waiting (and producing) as soon as the client disconnects.
  const closed = new AbortController();
  req.once('close', () => closed.abort());
  const write = async (payload: string) => {
    if (!res.write(payload)) {
      await once(res, 'drain', { signal: closed.signal }).catch(() => {});
    }
  };
  try {
    for await (const tick of math.countdown(from)) {
      if (closed.signal.aborted) return;
      await write(`data: ${JSON.stringify({ tick })}\n\n`);
      if (closed.signal.aborted) return;
      await new Promise((r) => setTimeout(r, 250)); // pace it for the eye
    }
    if (closed.signal.aborted) return;
    await write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (error) {
    if (!closed.signal.aborted) {
      await write(`data: ${JSON.stringify({ error: errorMessage(error) })}\n\n`);
    }
  }
  res.end();
}

// Every machine exposes './counter' with the same signature — one loadRemote
// shape, three runtimes.
const COUNTER_MACHINES = new Set(['compute_machine', 'java_machine', 'python_machine']);

interface CounterModule {
  current(): Promise<number>;
  increment(): Promise<number>;
}

async function handleCounter(req: http.IncomingMessage, res: http.ServerResponse) {
  const { machine } = await readBody(req);
  if (typeof machine !== 'string' || !COUNTER_MACHINES.has(machine)) {
    return json(res, 400, { error: `unknown machine "${machine}"` });
  }
  const counter = (await host.loadRemote<CounterModule>(`${machine}/counter`))!;
  const value = await counter.increment();
  json(res, 200, { value, loadRemote: `${machine}/counter`, wire: wire() });
}

// ---- chaos: kill a machine live, watch the resilience machinery ------------
// Act 06 promises crash + circuit-breaker hook events; this is the control
// that produces them for real. The kill is a federated call to an exposed
// admin function that makes the machine process.exit() right after answering.
// The host deliberately CANNOT bring the machine back — it is somebody
// else's deployment (containment) — the demo orchestrator (demo-web.mjs)
// supervises the process and respawns it; the host merely re-attaches.
const CHAOS_MACHINE = 'compute_machine';
// One more concurrent call than the plugin's default breaker threshold, so
// the burst visibly opens the circuit (derived from DEFAULT_POLICY so the
// demo cannot silently desync from the plugin default). Concurrency matters:
// all calls must hit the same dead-but-cached machine before the first
// failure evicts it.
const DEFAULT_BREAKER = DEFAULT_POLICY.circuitBreaker;
if (!DEFAULT_BREAKER) {
  throw new Error('[host] chaos demo expects the plugin default circuit breaker to be enabled');
}
const CHAOS_BURST = DEFAULT_BREAKER.threshold + 1;

let chaosBusy = false;

async function handleChaosKill(_req: http.IncomingMessage, res: http.ServerResponse) {
  if (chaosBusy) return json(res, 409, { error: 'a chaos sequence is already running' });
  chaosBusy = true;
  try {
    const admin = (await host.loadRemote<ComputeMachineModules['./admin']>(
      `${CHAOS_MACHINE}/admin`,
    ))!;
    const dying = await admin.die();
    // The guest answers first, then exits (~100ms): wait for it to be dead.
    // Machines are untrusted — clamp the guest-supplied delay so a bogus
    // value cannot wedge the chaos lock.
    await new Promise((r) => setTimeout(r, Math.min(Number(dying.exitingInMs) || 0, 1_000) + 200));
    const counter = (await host.loadRemote<CounterModule>(`${CHAOS_MACHINE}/counter`))!;
    const results = await Promise.allSettled(
      Array.from({ length: CHAOS_BURST }, () => counter.current()),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    const events = wire();
    json(res, 200, {
      killed: dying,
      burst: { attempted: CHAOS_BURST, failed },
      circuitOpened: events.some((e) => e.type === 'circuit' && e.state === 'open'),
      wire: events,
    });
  } finally {
    chaosBusy = false;
  }
}

/** One read-only call into the killed machine; the UI polls this until it heals. */
async function handleChaosProbe(_req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const counter = (await host.loadRemote<CounterModule>(`${CHAOS_MACHINE}/counter`))!;
    const value = await counter.current();
    json(res, 200, { recovered: true, value, wire: wire() });
  } catch (error) {
    json(res, 200, {
      recovered: false,
      errorName: errorName(error),
      error: errorMessage(error),
      wire: wire(),
    });
  }
}

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

function regionSlug(region: string): string {
  return region.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'region';
}

function vmstateShellKey(shell: VmstateShellIdentity): string {
  return JSON.stringify(shell);
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
  const shellKey = vmstateShellKey(shell);
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
  await Promise.allSettled([
    fluidSourcePlugin?.disposeMachines(),
    fluidRestorePlugin?.disposeMachines(),
  ]);
  fluidSourcePlugin = undefined;
  fluidRestorePlugin = undefined;
  fluidSourceHost = undefined;
  fluidRestoreHost = undefined;
  fluidRestoreShellKey = undefined;
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

async function handleFluidPrepare(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await readBody(req);
  const reset = body.reset !== false;
  const prepared = await prepareFluidSnapshot({ reset });
  json(res, 200, { ...prepared, wire: wire() });
}

async function handleFluidQuery(req: http.IncomingMessage, res: http.ServerResponse) {
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
  const preparedShellKey = preparedShell ? vmstateShellKey(preparedShell) : undefined;

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
  const start = performance.now();
  let remoteName = FLUID_ORIGIN_REMOTE;
  let workerModule = `${remoteName}/fluid`;
  let restore:
    | { artifact: 'vmstate'; entry: string; bytes: number; ms: number; cacheHit: boolean; digest?: string }
    | undefined;
  let restoreEntry: string | undefined;
  let workerHost: ReturnType<typeof createInstance> = host;
  if (decision.mode !== 'local') {
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
  const origin = await fluidModuleOn(host, FLUID_ORIGIN_REMOTE);
  const computed = await worker.compute(query, decision.replica);
  const backhaul = await origin.acceptBackhaul(decision.connection.from, computed.chunk);
  if (decision.mode !== 'local') {
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
}

async function handleFluidAdapt(req: http.IncomingMessage, res: http.ServerResponse) {
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
// ----------------------------------------------------------------------------

// ---- version negotiation rejection ------------------------------------------
// Every other trace shows the happy path. This control registers a SECOND
// remote name for the same running java machine, demanding ^2.0.0: the
// runtime fetches the manifest, compares versions, and refuses to attach
// (MachineVersionError — a real error from the real negotiation). force:true
// on every attempt drops any cached container so the demo is repeatable.
const STRICT_NAME = 'java_machine_strict';
const STRICT_REQUIRED = '^2.0.0';

/** The entry with its ?version= requirement replaced. */
function withVersionParam(entry: string, required: string): string {
  const [base, query = ''] = entry.split('?');
  const params = query
    .split('&')
    .filter((pair) => pair && !pair.startsWith('version='));
  // Raw (unencoded) param style, matching how entries are written everywhere.
  return `${base}?${[...params, `version=${required}`].join('&')}`;
}

async function handleVersionDemand(_req: http.IncomingMessage, res: http.ServerResponse) {
  const javaEntry = remotes.find((r) => r.name === 'java_machine')!.entry;
  const entry = withVersionParam(javaEntry, STRICT_REQUIRED);
  host.registerRemotes([{ name: STRICT_NAME, entry }], { force: true });
  try {
    await host.loadRemote(`${STRICT_NAME}/strings`);
    // Reaching here would mean the negotiation accepted ^2.0.0 — report it
    // honestly instead of fabricating a rejection.
    json(res, 200, { rejected: false, entry, required: STRICT_REQUIRED, wire: wire() });
  } catch (error) {
    const message = errorMessage(error);
    wire().push({
      type: 'reject',
      machine: STRICT_NAME,
      entry,
      required: STRICT_REQUIRED,
      error: message,
    });
    json(res, 200, {
      rejected: true,
      entry,
      required: STRICT_REQUIRED,
      errorName: errorName(error),
      error: message,
      // The version the machine reported, read from the plugin's typed error.
      reported: error instanceof MachineVersionError ? error.reported : undefined,
      wire: wire(),
    });
  }
}
// ----------------------------------------------------------------------------

// ---- typed-imports surface ---------------------------------------------------
// Every machine serves /mf-types.ts — its own typed bindings, the MF
// @mf-types analog (bindgen consumes exactly this). The browser can't reach
// machine addresses, so the host proxies the fetch from the entry's URL.

// Machines are untrusted: cap how much of their response the host will
// buffer and relay to the browser.
const MAX_TYPES_BYTES = 1024 * 1024;
const TYPES_CACHE_TTL_MS = 60_000;
const typesCache = new Map<string, { types: string; url: string; at: number }>();

async function handleTypes(_req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const name = url.searchParams.get('machine') ?? '';
  const machine = remotes.find((r) => r.name === name);
  if (!machine) return json(res, 400, { error: `unknown machine "${name}"` });
  const spec = parseMachineEntry(name, machine.entry);
  if (spec.kind === 'image' && spec.image) {
    const typesFile = path.join(path.dirname(spec.image), 'mf-types.ts');
    const cached = typesCache.get(name);
    if (cached && cached.url === typesFile && Date.now() - cached.at < TYPES_CACHE_TTL_MS) {
      return json(res, 200, { machine: name, url: cached.url, types: cached.types });
    }
    try {
      const info = await stat(typesFile);
      if (info.size > MAX_TYPES_BYTES) {
        return json(res, 502, { error: `machine's /mf-types.ts exceeds ${MAX_TYPES_BYTES} bytes` });
      }
      const types = await readFile(typesFile, 'utf8');
      typesCache.set(name, { types, url: typesFile, at: Date.now() });
      return json(res, 200, { machine: name, url: typesFile, types });
    } catch (error) {
      return json(res, 502, { error: `machine types artifact unavailable: ${errorMessage(error)}` });
    }
  }
  const base = machine.entry.replace(/^machinen\+/, '').split('?')[0];
  const typesUrl = `${base}/mf-types.ts`;
  const cached = typesCache.get(name);
  if (cached && cached.url === typesUrl && Date.now() - cached.at < TYPES_CACHE_TTL_MS) {
    return json(res, 200, { machine: name, url: cached.url, types: cached.types });
  }
  let upstream: Response;
  try {
    upstream = await fetch(typesUrl, { signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    return json(res, 502, { error: `machine unreachable: ${errorMessage(error)}` });
  }
  if (!upstream.ok) {
    return json(res, 502, { error: `machine answered ${upstream.status} for /mf-types.ts` });
  }
  // Cap what the host BUFFERS, not just what it relays: a hostile machine
  // can omit content-length (chunked encoding), so count bytes as they
  // stream and cancel the moment the cap is crossed.
  const chunks: Buffer[] = [];
  let bytes = 0;
  const reader = upstream.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_TYPES_BYTES) {
        await reader.cancel().catch(() => {});
        return json(res, 502, { error: `machine's /mf-types.ts exceeds ${MAX_TYPES_BYTES} bytes` });
      }
      chunks.push(Buffer.from(value));
    }
  }
  const types = Buffer.concat(chunks).toString();
  typesCache.set(name, { types, url: typesUrl, at: Date.now() });
  json(res, 200, {
    machine: name,
    url: typesUrl,
    types,
  });
}
// ----------------------------------------------------------------------------

// ---- data gravity: deploy-by-pull -------------------------------------------
// Scenario 2's first beat is a real deployment: the host asks the eu-west
// region agent (across the WAN) to pull the analytics IMAGE from its us-east
// origin and boot it next to db_machine. The agent answers with its own
// artifact-hook payload — bytes, digest, cache hit/miss, timings — so the UI
// shows exactly what moved. Until the deploy happens, the host's analytics
// entry exists in config but the machine doesn't exist.
const REGION_AGENT_URL = process.env.REGION_AGENT_URL;

async function agentFetch(pathname: string, init?: RequestInit): Promise<Record<string, unknown>> {
  if (!REGION_AGENT_URL) {
    throw new HttpError(503, 'no region agent configured (REGION_AGENT_URL) — run scripts/demo-web.mjs');
  }
  const upstream = await fetch(`${REGION_AGENT_URL}${pathname}`, init).catch((error) => {
    throw new HttpError(502, `region agent unreachable: ${errorMessage(error)}`);
  });
  const body = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
  if (!upstream.ok) {
    throw new HttpError(502, `region agent answered ${upstream.status}: ${String(body.error ?? '')}`);
  }
  return body;
}

async function handleGravityState(_req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    json(res, 200, { ...(await agentFetch('/status')), agent: 'reachable' });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 502;
    json(res, 200, { agent: 'unreachable', error: errorMessage(error), status });
  }
}

async function handleGravityDeploy(_req: http.IncomingMessage, res: http.ServerResponse) {
  const start = performance.now();
  const reply = await agentFetch('/deploy', { method: 'POST' });
  json(res, 200, { ...reply, wanMs: Math.round(performance.now() - start) });
}
// ----------------------------------------------------------------------------

/**
 * The WAN latency a report actually ran at, read from the latency proxy's
 * control endpoint (instant — the control path skips the simulated delay).
 * Null when the link is unreachable; the UI omits the annotation.
 */
async function currentWanLatencyMs(): Promise<number | null> {
  try {
    const upstream = await fetch(`${REGION_LINKS[0]}/__latency`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!upstream.ok) return null;
    const body = (await upstream.json()) as { ms?: unknown };
    return typeof body.ms === 'number' ? body.ms : null;
  } catch {
    return null;
  }
}

// Data gravity: the same report, two topologies. The host's db_machine entry
// routes through the simulated WAN, so this sequential N+1 pays region
// latency per query.
async function handleReportRemote(req: http.IncomingMessage, res: http.ServerResponse) {
  const { limit = 5 } = await readBody(req);
  const wanLatencyMs = await currentWanLatencyMs();
  const start = performance.now();

  const db = (await host.loadRemote<DbMachineModules['./db']>('db_machine/db'))!;
  const users = await db.listUsers();
  let queries = 1;
  const totals: { name: string; plan: string; total: number }[] = [];
  for (const user of users) {
    const orders = await db.ordersFor(user.id);
    queries++;
    totals.push({
      name: user.name,
      plan: user.plan,
      total: Math.round(orders.reduce((sum, o) => sum + o.amount, 0) * 100) / 100,
    });
  }
  totals.sort((a, b) => b.total - a.total);

  json(res, 200, {
    scenario: 'cross-region',
    spenders: totals.slice(0, Math.max(1, Math.min(Number(limit) || 5, 10))),
    wanCalls: queries,
    dbQueries: queries,
    totalMs: performance.now() - start,
    wanLatencyMs,
    loadRemote: 'db_machine/db',
    wire: wire(),
  });
}

// One federated call to analytics_machine (co-located with the db), which
// runs the same N+1 over same-region hops.
async function handleReportColocated(req: http.IncomingMessage, res: http.ServerResponse) {
  const { limit = 5 } = await readBody(req);
  const wanLatencyMs = await currentWanLatencyMs();
  const start = performance.now();
  const analytics = (
    await host.loadRemote<AnalyticsMachineModules['./analytics']>('analytics_machine/analytics')
  )!;
  const report = await analytics.topSpenders(Number(limit) || 5);
  json(res, 200, {
    scenario: 'colocated',
    spenders: report.spenders,
    wanCalls: 1,
    dbQueries: report.queries,
    machineMs: report.dbMs,
    totalMs: performance.now() - start,
    wanLatencyMs,
    loadRemote: 'analytics_machine/analytics',
    wire: wire(),
  });
}

async function handleRegionLatency(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.method === 'POST') {
    const { ms } = await readBody(req);
    const results = await Promise.allSettled(
      REGION_LINKS.map(async (link) => {
        const upstream = await fetch(`${link}/__latency`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ms }),
        });
        if (!upstream.ok) throw new Error(`region link ${link} answered ${upstream.status}`);
        return upstream.json();
      }),
    );
    const failed = results
      .map((r, i) => (r.status === 'rejected' ? `${REGION_LINKS[i]}: ${errorMessage(r.reason)}` : null))
      .filter((msg): msg is string => msg !== null);
    if (failed.length) {
      // Partial success means the two proxies may now disagree — say so.
      const applied = results.length - failed.length;
      return json(res, 502, {
        error:
          `failed to set latency on ${failed.length}/${results.length} region links` +
          (applied > 0 ? ` (${applied} updated — links may now differ)` : '') +
          `: ${failed.join('; ')}`,
      });
    }
    json(res, 200, (results[0] as PromiseFulfilledResult<unknown>).value);
    return;
  }
  const upstream = await fetch(`${REGION_LINKS[0]}/__latency`);
  if (!upstream.ok) return json(res, 502, { error: `region link answered ${upstream.status}` });
  json(res, 200, await upstream.json());
}

type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
) => Promise<void> | void;

const routes = new Map<string, RouteHandler>([
  [
    'GET /favicon.ico',
    (_req, res) => {
      res.writeHead(204, { 'cache-control': 'public, max-age=3600' });
      res.end();
    },
  ],
  [
    'GET /api/dashboard',
    (req, res) =>
      handleDashboard(req, res, { plugin, machines: MACHINES, remotes, lifecycleBody, vmBody: vmLaneBody }),
  ],
  ['POST /api/pipeline', handlePipeline],
  ['GET /api/countdown', handleCountdown],
  ['POST /api/counter', handleCounter],
  ['POST /api/fluid/prepare', handleFluidPrepare],
  ['POST /api/fluid/query', handleFluidQuery],
  ['POST /api/fluid/adapt', handleFluidAdapt],
  ['POST /api/chaos/kill', handleChaosKill],
  ['POST /api/chaos/probe', handleChaosProbe],
  ['POST /api/version/demand', handleVersionDemand],
  ['GET /api/types', handleTypes],
  ['POST /api/lifecycle/boot', handleLifecycleBoot],
  ['POST /api/lifecycle/freeze', handleLifecycleFreeze],
  ['POST /api/lifecycle/restore', handleLifecycleRestore],
  ['POST /api/lifecycle/pull', handleLifecyclePull],
  ['POST /api/lifecycle/counter', handleLifecycleCounter],
  // Whole-VM lane: capability truth + the live microVM arc (vm-lane.ts).
  ['GET /api/vm/capability', (_req, res) => json(res, 200, vmCapability)],
  ['GET /api/vm/state', handleVmState],
  ['POST /api/vm/boot', handleVmBoot],
  ['POST /api/vm/publish', handleVmPublish],
  ['POST /api/vm/restore', handleVmRestore],
  ['POST /api/vm/reset', handleVmReset],
  ['GET /api/vm/replay', handleVmReplay],
  ['GET /api/gravity/state', handleGravityState],
  ['POST /api/gravity/deploy', handleGravityDeploy],
  ['POST /api/report/remote', handleReportRemote],
  ['POST /api/report/colocated', handleReportColocated],
  ['GET /api/region/latency', handleRegionLatency],
  ['POST /api/region/latency', handleRegionLatency],
  ['GET /api/android/status', handleAndroidStatus],
  ['POST /api/android/boot', handleAndroidBoot],
  ['POST /api/android/launch', handleAndroidLaunch],
  ['POST /api/android/freeze', handleAndroidFreeze],
  ['POST /api/android/resume', handleAndroidResume],
  ['POST /api/android/reset', handleAndroidReset],
]);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  try {
    const handler = routes.get(`${req.method} ${url.pathname}`);
    // Every handler runs inside a fresh wire-capture scope, so hook events
    // recorded during this request belong to this request only.
    if (handler) return await wireStore.run([], () => handler(req, res, url));
    if (await serveStatic(req, res, url)) return;
    json(res, 404, { error: 'not found' });
  } catch (error) {
    if (error instanceof HttpError) return json(res, error.status, { error: error.message });
    json(res, 500, { error: errorMessage(error) });
  }
});

// GET /vnc upgrade: splice the browser's websocket onto the android lab's
// forwarded qemu VNC listener. qemu speaks the websocket protocol itself, so
// the original upgrade request is replayed verbatim.
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', `http://localhost:${PORT}`).pathname;
  const target = pathname === '/vnc' ? androidVncPort() : undefined;
  if (!target) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return;
  }
  const upstream = net.connect(target, '127.0.0.1');
  upstream.on('connect', () => {
    // Path rewritten to '/': qemu's websocket server 404s anything else.
    const lines = [`${req.method} / HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(PORT, () => {
  console.log(`[host] web demo on http://localhost:${PORT}`);
  console.log('[host] machines attach on demand — watch the dashboard');
});

// The lifecycle guests (origin + clones) are child processes of this host and
// inherit its stdio — they must not outlive it, or they wedge piped demo
// output and poison the fixed origin port for the next run. The vm lane's
// microVMs (and their GB-scale on-disk artifacts) go with them.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void Promise.allSettled([
      snapPlugin.disposeMachines(),
      fluidSourcePlugin?.disposeMachines(),
      fluidRestorePlugin?.disposeMachines(),
      disposeVmLane(),
      disposeAndroidLab(),
    ]).finally(() => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref();
    });
  });
}
