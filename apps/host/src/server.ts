// Interactive demo backend: every handler is plain binding usage; machines
// attach lazily on first call.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getMachines } from '@federated-compute/machinen-plugin/client';
import { math, text, counter as nodeCounter } from './generated/compute_machine';
import { strings, counter as javaCounter } from './generated/java_machine';
import { stats, data, counter as pyCounter } from './generated/python_machine';
import { db } from './generated/db_machine';
import { analytics } from './generated/analytics_machine';

const PORT = Number(process.env.HOST_PORT ?? 3800);
// All simulated WAN links into the data region (db + analytics paths).
const REGION_LINKS = (process.env.REGION_LINKS ?? 'http://127.0.0.1:3899,http://127.0.0.1:3898')
  .split(',')
  .map((s) => s.trim());
const MACHINES = ['compute_machine', 'java_machine', 'python_machine'] as const;

interface MachineStatus {
  attached: boolean;
  runtime?: string;
  version?: string;
  attachedAt?: number;
}

interface ActivityEvent {
  ts: number;
  kind: 'ready' | 'call' | 'error' | 'crash' | 'circuit';
  detail: string;
}

const machineStatus = new Map<string, MachineStatus>(
  MACHINES.map((name) => [name, { attached: false }]),
);
const events: ActivityEvent[] = [];

function logEvent(kind: ActivityEvent['kind'], detail: string) {
  events.push({ ts: Date.now(), kind, detail });
  if (events.length > 200) events.splice(0, events.length - 200);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const plugin = getMachines().plugin;
plugin.machineHooks.onMachineReady.on(({ spec, manifest }) => {
  machineStatus.set(spec.remoteName, {
    attached: true,
    runtime: manifest.metaData?.runtime,
    version: manifest.version,
    attachedAt: Date.now(),
  });
  logEvent('ready', `${spec.remoteName} attached (${manifest.metaData?.runtime})`);
});
plugin.machineHooks.afterCall.on(({ spec, module, fn, durationMs }) => {
  logEvent('call', `${spec.remoteName} ${module}#${fn} ${durationMs.toFixed(1)}ms`);
});
plugin.machineHooks.onMachineError.on(({ spec, module, fn, error }) => {
  logEvent('error', `${spec.remoteName} ${module}#${fn} failed: ${errorMessage(error)}`);
});
plugin.machineHooks.onMachineCrash.on(({ spec }) => {
  machineStatus.set(spec.remoteName, { attached: false });
  logEvent('crash', `${spec.remoteName} became unreachable`);
});
plugin.machineHooks.onCircuitOpen.on(({ spec }) => {
  logEvent('circuit', `${spec.remoteName} circuit open — failing fast`);
});

const counters = {
  compute_machine: nodeCounter,
  java_machine: javaCounter,
  python_machine: pyCounter,
};

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += (chunk as Buffer).length;
    if (bytes > 64 * 1024) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handleStatus(res: http.ServerResponse) {
  const metrics = getMachines().metrics();
  json(res, 200, {
    machines: MACHINES.map((name) => ({
      name,
      ...machineStatus.get(name),
      metrics: metrics[name] ?? null,
    })),
  });
}

/** One request fanning out across three machines in three languages. */
async function handlePipeline(req: http.IncomingMessage, res: http.ServerResponse) {
  const { text: input } = await readBody(req);
  if (typeof input !== 'string' || !input.trim()) {
    return json(res, 400, { error: 'expected { text: string }' });
  }

  const totalStart = performance.now();

  const javaStart = performance.now();
  const [digest, upper] = await Promise.all([strings.sha256(input), strings.upper(input)]);
  const javaMs = performance.now() - javaStart;

  const pyStart = performance.now();
  const wordCount = await data.wordCount(input);
  const lengths = Object.keys(wordCount).map((w) => w.length);
  const [meanLen, medianLen] = lengths.length
    ? await Promise.all([stats.mean(lengths), stats.median(lengths)])
    : [0, 0];
  const pyMs = performance.now() - pyStart;

  const nodeStart = performance.now();
  const [shouted, reversed] = await Promise.all([text.shout(input), text.reverse(input)]);
  const nodeMs = performance.now() - nodeStart;

  json(res, 200, {
    java: { sha256: digest, upper, ms: javaMs },
    python: { wordCount, meanWordLength: meanLen, medianWordLength: medianLen, ms: pyMs },
    node: { shouted, reversed, ms: nodeMs },
    totalMs: performance.now() - totalStart,
  });
}

async function handleCompute(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await readBody(req);
  if (body.op === 'add') {
    return json(res, 200, { result: await math.add(Number(body.a), Number(body.b)) });
  }
  if (body.op === 'fib') {
    const n = Math.min(Math.max(Number(body.n) || 0, 0), 35);
    return json(res, 200, { result: await math.fib(n), n });
  }
  return json(res, 400, { error: 'expected op: add | fib' });
}

/** Stream crossing two boundaries: machine -> host (NDJSON) -> browser (SSE). */
async function handleCountdown(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const from = Math.min(Math.max(Number(url.searchParams.get('from')) || 5, 1), 30);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  let closed = false;
  req.on('close', () => {
    closed = true;
  });
  try {
    for await (const tick of math.countdown(from)) {
      if (closed) return;
      res.write(`data: ${JSON.stringify({ tick })}\n\n`);
      await new Promise((r) => setTimeout(r, 250)); // pace it for the eye
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (error) {
    res.write(`data: ${JSON.stringify({ error: errorMessage(error) })}\n\n`);
  }
  res.end();
}

async function handleCounter(req: http.IncomingMessage, res: http.ServerResponse) {
  const { machine } = await readBody(req);
  const counter = counters[machine as keyof typeof counters];
  if (!counter) return json(res, 400, { error: `unknown machine "${machine}"` });
  json(res, 200, { value: await counter.increment() });
}

// Data gravity: the same report, two topologies. The host's db_machine entry
// routes through the simulated WAN, so this sequential N+1 pays region
// latency per query.
async function handleReportRemote(req: http.IncomingMessage, res: http.ServerResponse) {
  const { limit = 5 } = await readBody(req);
  const start = performance.now();

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
  });
}

// One federated call to analytics_machine (co-located with the db), which
// runs the same N+1 over same-region hops.
async function handleReportColocated(req: http.IncomingMessage, res: http.ServerResponse) {
  const { limit = 5 } = await readBody(req);
  const start = performance.now();
  const report = await analytics.topSpenders(Number(limit) || 5);
  json(res, 200, {
    scenario: 'colocated',
    spenders: report.spenders,
    wanCalls: 1,
    dbQueries: report.queries,
    machineMs: report.dbMs,
    totalMs: performance.now() - start,
  });
}

async function handleRegionLatency(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.method === 'POST') {
    const { ms } = await readBody(req);
    const results = await Promise.all(
      REGION_LINKS.map(async (link) => {
        const upstream = await fetch(`${link}/__latency`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ms }),
        });
        if (!upstream.ok) throw new Error(`region link ${link} answered ${upstream.status}`);
        return upstream.json();
      }),
    ).catch((error) => {
      json(res, 502, { error: errorMessage(error) });
      return undefined;
    });
    if (results) json(res, 200, results[0]);
    return;
  }
  const upstream = await fetch(`${REGION_LINKS[0]}/__latency`);
  if (!upstream.ok) return json(res, 502, { error: `region link answered ${upstream.status}` });
  json(res, 200, await upstream.json());
}

const PUBLIC_DIR = path.resolve(import.meta.dirname, '../public');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(await readFile(path.join(PUBLIC_DIR, 'index.html')));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/gravity') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(await readFile(path.join(PUBLIC_DIR, 'gravity.html')));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/report/remote') {
      return await handleReportRemote(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/report/colocated') {
      return await handleReportColocated(req, res);
    }
    if (url.pathname === '/api/region/latency') {
      return await handleRegionLatency(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return await handleStatus(res);
    if (req.method === 'GET' && url.pathname === '/api/events') {
      return json(res, 200, { events: events.slice(-40) });
    }
    if (req.method === 'POST' && url.pathname === '/api/pipeline') {
      return await handlePipeline(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/compute') {
      return await handleCompute(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/api/countdown') {
      return await handleCountdown(req, res, url);
    }
    if (req.method === 'POST' && url.pathname === '/api/counter') {
      return await handleCounter(req, res);
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (error) {
    json(res, 500, { error: errorMessage(error) });
  }
});

server.listen(PORT, () => {
  console.log(`[host] web demo on http://localhost:${PORT}`);
  console.log('[host] machines attach on demand — watch the dashboard');
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
