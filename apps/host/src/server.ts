// Interactive demo backend. The host is a stock Module Federation runtime
// consumer — createInstance({ remotes, plugins }) + host.loadRemote(...) —
// exactly the shape from module-federation.io, except the remotes are
// machines: the machinen plugin claims `machinen+http://` entries and turns
// them into containers of typed async function proxies.
//
// IMPORTANT for readers: federation happens HERE, in this Node process. The
// browser only ever does plain fetch('/api/...'); every loadRemote below runs
// server-side, and every machine call is an HTTP RPC (POST /mf/call) from
// this process into the machine. The /api responses include a `wire` array —
// real data captured from the plugin's hooks — so the UI can show exactly
// what crossed which boundary.
import { AsyncLocalStorage } from 'node:async_hooks';
import { once } from 'node:events';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInstance } from '@module-federation/runtime';
import {
  httpAttachDriver,
  machinenPlugin,
  processDriver,
  type MachinenPlugin,
} from '@federated-compute/machinen-plugin';
import type { ComputeMachineModules } from './generated/compute_machine';
import type { JavaMachineModules } from './generated/java_machine';
import type { PythonMachineModules } from './generated/python_machine';
import type { DbMachineModules } from './generated/db_machine';
import type { AnalyticsMachineModules } from './generated/analytics_machine';

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

/** Machine entry: deploy-time env override, or the dev-loop default port. */
function entryFor(name: string, port: number): string {
  return (
    process.env[`MACHINEN_REMOTE_${name.toUpperCase()}`] ??
    `machinen+http://127.0.0.1:${port}?version=^1.0.0`
  );
}

const remotes = MACHINES.map(({ name, port }) => ({ name, entry: entryFor(name, port) }));

// ---- the entire federation setup ------------------------------------------
const plugin = machinenPlugin({ driver: httpAttachDriver() });
const host = createInstance({
  name: 'host',
  remotes,
  plugins: [plugin],
});
// ----------------------------------------------------------------------------

// ---- wire capture -----------------------------------------------------------
// Per-request recording of what federation actually did: attaches (manifest
// fetch + version negotiation) and calls (the literal /mf/call RPC). Hook
// listeners append into the AsyncLocalStorage store of whichever /api request
// is running, so concurrent requests can't see each other's traffic.

type WireEvent =
  | {
      type: 'attach';
      machine: string;
      entry: string;
      url?: string;
      version?: string;
      requires?: string;
      runtime?: string;
    }
  | {
      type: 'call';
      machine: string;
      url?: string;
      module: string;
      fn: string;
      args: string;
      result: string;
      ms: number;
    }
  | { type: 'snapshot'; machine: string; snapFile: string };

const wireStore = new AsyncLocalStorage<WireEvent[]>();

/** JSON-serialize a value for display, clipped so payloads stay readable. */
function clip(value: unknown, max = 140): string {
  let s: string;
  try {
    s = JSON.stringify(value) ?? 'undefined';
  } catch {
    s = String(value);
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Record attach/call/snapshot hook events into the current request's wire. */
function recordWire(p: MachinenPlugin): void {
  p.machineHooks.onMachineReady.on(({ spec, manifest }) => {
    wireStore.getStore()?.push({
      type: 'attach',
      machine: spec.remoteName,
      entry: spec.entry,
      url: spec.url,
      version: manifest.version,
      requires: spec.params.get('version') ?? undefined,
      runtime: manifest.metaData?.runtime,
    });
  });
  p.machineHooks.afterCall.on(({ spec, module, fn, args, result, durationMs }) => {
    wireStore.getStore()?.push({
      type: 'call',
      machine: spec.remoteName,
      url: spec.url,
      module,
      fn,
      args: clip(args),
      result: clip(result),
      ms: durationMs,
    });
  });
  p.machineHooks.onSnapshotted.on(({ spec, snapshot }) => {
    const snapFile = (snapshot as { snapFile?: string })?.snapFile ?? '(driver descriptor)';
    wireStore.getStore()?.push({ type: 'snapshot', machine: spec.remoteName, snapFile });
  });
}

/** The wire events captured so far for the current request. */
function wire(): WireEvent[] {
  return wireStore.getStore() ?? [];
}
// ----------------------------------------------------------------------------

interface MachineStatus {
  attached: boolean;
  runtime?: string;
  version?: string;
  attachedAt?: number;
}

interface ActivityEvent {
  ts: number;
  kind: 'ready' | 'call' | 'error' | 'crash' | 'circuit' | 'snapshot' | 'restore';
  detail: string;
}

const machineStatus = new Map<string, MachineStatus>(
  MACHINES.map(({ name }) => [name, { attached: false }]),
);

/** Fixed-capacity ring buffer: O(1) push, oldest entries overwritten. */
class RingBuffer<T> {
  private readonly buffer: T[];
  private head = 0;
  private size = 0;

  constructor(private readonly capacity: number) {
    this.buffer = new Array<T>(capacity);
  }

  push(item: T) {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  /** Last n items, newest-last. */
  latest(n: number): T[] {
    const count = Math.min(n, this.size);
    const out: T[] = new Array(count);
    for (let i = 0; i < count; i++) {
      out[i] = this.buffer[(this.head - count + i + this.capacity) % this.capacity];
    }
    return out;
  }
}

const events = new RingBuffer<ActivityEvent>(200);

function logEvent(kind: ActivityEvent['kind'], detail: string) {
  events.push({ ts: Date.now(), kind, detail });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Feed a plugin's lifecycle hooks into the dashboard's activity log. */
function logHooks(p: MachinenPlugin): void {
  p.machineHooks.onMachineReady.on(({ spec, manifest }) => {
    if (machineStatus.has(spec.remoteName)) {
      machineStatus.set(spec.remoteName, {
        attached: true,
        runtime: manifest.metaData?.runtime,
        version: manifest.version,
        attachedAt: Date.now(),
      });
    }
    logEvent('ready', `${spec.remoteName} attached (${manifest.metaData?.runtime})`);
  });
  p.machineHooks.afterCall.on(({ spec, module, fn, durationMs }) => {
    logEvent('call', `${spec.remoteName} ${module}#${fn} ${durationMs.toFixed(1)}ms`);
  });
  p.machineHooks.onMachineError.on(({ spec, module, fn, error }) => {
    logEvent('error', `${spec.remoteName} ${module}#${fn} failed: ${errorMessage(error)}`);
  });
  p.machineHooks.onMachineCrash.on(({ spec }) => {
    if (machineStatus.has(spec.remoteName)) {
      machineStatus.set(spec.remoteName, { attached: false });
    }
    logEvent('crash', `${spec.remoteName} became unreachable`);
  });
  p.machineHooks.onCircuitOpen.on(({ spec }) => {
    logEvent('circuit', `${spec.remoteName} circuit open — failing fast`);
  });
  p.machineHooks.onSnapshotted.on(({ spec, snapshot }) => {
    const snapFile = (snapshot as { snapFile?: string })?.snapFile;
    logEvent('snapshot', `${spec.remoteName} frozen${snapFile ? ` -> ${path.basename(snapFile)}` : ''}`);
  });
}

logHooks(plugin);
recordWire(plugin);

/** Request-level failure with a definite HTTP status (vs a generic 500). */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += (chunk as Buffer).length;
    if (bytes > 64 * 1024) throw new HttpError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    // Deliberately constant message: JSON.parse errors echo request content.
    throw new HttpError(400, 'invalid JSON body');
  }
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function handleDashboard(_req: http.IncomingMessage, res: http.ServerResponse) {
  const metrics = plugin.metrics();
  json(res, 200, {
    machines: MACHINES.map(({ name, region }, i) => ({
      name,
      region,
      entry: remotes[i].entry,
      ...machineStatus.get(name),
      metrics: metrics[name] ?? null,
    })),
    events: events.latest(40),
  });
}

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

async function handleCompute(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await readBody(req);
  const math = (await host.loadRemote<ComputeMachineModules['./math']>('compute_machine/math'))!;
  if (body.op === 'add') {
    const result = await math.add(Number(body.a), Number(body.b));
    return json(res, 200, { result, loadRemote: 'compute_machine/math', wire: wire() });
  }
  if (body.op === 'fib') {
    const n = Math.min(Math.max(Number(body.n) || 0, 0), 35);
    const result = await math.fib(n);
    return json(res, 200, { result, n, loadRemote: 'compute_machine/math', wire: wire() });
  }
  return json(res, 400, { error: 'expected op: add | fib' });
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

// ---- snapshot story ---------------------------------------------------------
// The five machines above are attached deployments (httpAttachDriver), so the
// host can't freeze them. The snapshot card boots its OWN machine from an
// image via the process driver — the same federation runtime shape, but the
// driver owns the process, so plugin.snapshotMachine() and restore-from-.snap
// work. scripts/demo-snapshot.mjs is the CLI version of this exact story; the
// real-VM variant (machinenDriver(), whole microVM dumps) is pnpm demo:machinen.

const SNAP_IMAGE =
  process.env.SNAPSHOT_IMAGE ?? path.resolve(import.meta.dirname, '../../remote/dist/index.js');
const SNAP_DIR = path.resolve(import.meta.dirname, '../.machinen/web-snapshots');
const SNAP_NAME = 'snap_machine';

const snapPlugin = machinenPlugin({ driver: processDriver({ snapshotDir: SNAP_DIR }) });
const snapHost = createInstance({
  name: 'snapshot_host',
  remotes: [{ name: SNAP_NAME, entry: `machinen://${SNAP_IMAGE}` }],
  plugins: [snapPlugin],
});
logHooks(snapPlugin);
recordWire(snapPlugin);

interface SnapState {
  phase: 'cold' | 'running' | 'snapshotted' | 'restored';
  value?: number;
  snapFile?: string;
  snapBytes?: number;
  busy: boolean;
}

const snapState: SnapState = { phase: 'cold', busy: false };

function snapStateBody() {
  const { busy: _busy, snapFile, ...rest } = snapState;
  return { ...rest, snapFile: snapFile ? path.basename(snapFile) : undefined };
}

/** Serialize the snapshot lifecycle: one step at a time, valid phases only. */
async function snapStep<T>(
  res: http.ServerResponse,
  allowed: SnapState['phase'][],
  step: () => Promise<T>,
): Promise<void> {
  if (snapState.busy) return json(res, 409, { error: 'a snapshot step is already running' });
  if (!allowed.includes(snapState.phase)) {
    return json(res, 409, {
      error: `step not valid in phase "${snapState.phase}" (expected ${allowed.join(' | ')})`,
    });
  }
  snapState.busy = true;
  try {
    const extra = await step();
    json(res, 200, { ...snapStateBody(), ...extra, wire: wire() });
  } finally {
    snapState.busy = false;
  }
}

function handleSnapshotState(_req: http.IncomingMessage, res: http.ServerResponse) {
  json(res, 200, snapStateBody());
}

/** Boot (or reboot) snap_machine from its image and work it warm. */
async function handleSnapshotBoot(_req: http.IncomingMessage, res: http.ServerResponse) {
  await snapStep(res, ['cold', 'running', 'snapshotted', 'restored'], async () => {
    // (Re)point the remote at the pristine image — a normal dynamic-remotes
    // operation; force drops the cached container for the name.
    await snapPlugin.disposeMachines();
    snapHost.registerRemotes([{ name: SNAP_NAME, entry: `machinen://${SNAP_IMAGE}` }], {
      force: true,
    });
    const counter = (await snapHost.loadRemote<CounterModule>(`${SNAP_NAME}/counter`))!;
    await counter.increment();
    await counter.increment();
    snapState.value = await counter.increment();
    snapState.phase = 'running';
    snapState.snapFile = undefined;
    snapState.snapBytes = undefined;
    return { loadRemote: `${SNAP_NAME}/counter` };
  });
}

/** Freeze the machine's app state into a .snap bundle, then kill the process. */
async function handleSnapshotFreeze(_req: http.IncomingMessage, res: http.ServerResponse) {
  await snapStep(res, ['running'], async () => {
    const snapshot = (await snapPlugin.snapshotMachine(SNAP_NAME)) as { snapFile: string };
    await snapPlugin.disposeMachines(); // the process is gone — state lives only in the bundle
    logEvent('snapshot', `${SNAP_NAME} process killed — state lives in the .snap bundle`);
    snapState.phase = 'snapshotted';
    snapState.snapFile = snapshot.snapFile;
    snapState.snapBytes = (await stat(snapshot.snapFile)).size;
    return {};
  });
}

/** Restore: point the SAME remote name at the .snap and loadRemote again. */
async function handleSnapshotRestore(_req: http.IncomingMessage, res: http.ServerResponse) {
  await snapStep(res, ['snapshotted'], async () => {
    snapHost.registerRemotes(
      [{ name: SNAP_NAME, entry: `machinen://${snapState.snapFile}` }],
      { force: true },
    );
    const counter = (await snapHost.loadRemote<CounterModule>(`${SNAP_NAME}/counter`))!;
    const resumed = await counter.current();
    const next = await counter.increment();
    logEvent('restore', `${SNAP_NAME} restored from .snap — counter resumed at ${resumed}`);
    snapState.phase = 'restored';
    snapState.value = next;
    return { resumed, next, loadRemote: `${SNAP_NAME}/counter` };
  });
}
// ----------------------------------------------------------------------------

// Data gravity: the same report, two topologies. The host's db_machine entry
// routes through the simulated WAN, so this sequential N+1 pays region
// latency per query.
async function handleReportRemote(req: http.IncomingMessage, res: http.ServerResponse) {
  const { limit = 5 } = await readBody(req);
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
    loadRemote: 'db_machine/db',
    wire: wire(),
  });
}

// One federated call to analytics_machine (co-located with the db), which
// runs the same N+1 over same-region hops.
async function handleReportColocated(req: http.IncomingMessage, res: http.ServerResponse) {
  const { limit = 5 } = await readBody(req);
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

const PUBLIC_DIR = path.resolve(import.meta.dirname, '../public');

// Pretty page routes -> files in PUBLIC_DIR; other assets (*.css) are served
// by filename. The asset pattern admits no '/' so paths can't escape the dir.
const PAGES: Record<string, string> = { '/': 'index.html', '/gravity': 'gravity.html' };
const CSS_ASSET_RE = /^\/[A-Za-z0-9_-]+\.css$/;

/** Serve a page or asset from PUBLIC_DIR; false when the path is not static. */
async function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  const page = PAGES[url.pathname];
  const file = page ?? (CSS_ASSET_RE.test(url.pathname) ? url.pathname.slice(1) : undefined);
  if (!file) return false;
  try {
    const body = await readFile(path.join(PUBLIC_DIR, file));
    res.writeHead(200, { 'content-type': page ? 'text/html' : 'text/css' });
    res.end(body);
  } catch {
    json(res, 404, { error: 'not found' });
  }
  return true;
}

type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
) => Promise<void> | void;

const routes = new Map<string, RouteHandler>([
  ['GET /api/dashboard', handleDashboard],
  ['POST /api/pipeline', handlePipeline],
  ['POST /api/compute', handleCompute],
  ['GET /api/countdown', handleCountdown],
  ['POST /api/counter', handleCounter],
  ['GET /api/snapshot/state', handleSnapshotState],
  ['POST /api/snapshot/boot', handleSnapshotBoot],
  ['POST /api/snapshot/freeze', handleSnapshotFreeze],
  ['POST /api/snapshot/restore', handleSnapshotRestore],
  ['POST /api/report/remote', handleReportRemote],
  ['POST /api/report/colocated', handleReportColocated],
  ['GET /api/region/latency', handleRegionLatency],
  ['POST /api/region/latency', handleRegionLatency],
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

server.listen(PORT, () => {
  console.log(`[host] web demo on http://localhost:${PORT}`);
  console.log('[host] machines attach on demand — watch the dashboard');
});

process.on('SIGTERM', () => {
  void snapPlugin.disposeMachines().catch(() => {});
  server.close(() => process.exit(0));
});
