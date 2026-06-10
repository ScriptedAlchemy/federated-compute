// Interactive web demo: machines run as separate deployments, the host serves
// a dashboard at http://localhost:3800 where every button is a federated
// machine call. Ctrl-C stops everything.
//
// `--smoke` runs a headless check pass against the running stack and exits.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startWanLinks } from './latency-proxy.mjs';
import { HOST_PORT, PORTS, remoteEnv, startMachines, WAN_PORTS } from './machines.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smoke = process.argv.includes('--smoke');

const { stop } = await startMachines();
// Simulated WAN links into the data region: BOTH paths cross it — querying
// the db directly, and calling the co-located analytics machine.
let wan;
try {
  wan = await startWanLinks({ latencyMs: 75 });
} catch (error) {
  console.error(`[demo-web] failed to start WAN links: ${error.message}`);
  stop();
  process.exit(1);
}

const host = spawn('node', [path.join(ROOT, 'apps/host/dist/server.js')], {
  env: {
    ...process.env,
    // Everything in the data region is reached THROUGH the WAN links.
    ...remoteEnv(Object.keys(PORTS), { wan: Object.keys(WAN_PORTS) }),
    REGION_LINKS: wan.regionLinks,
  },
  stdio: 'inherit',
});

let shuttingDown = false;
const shutdown = (code) => {
  if (shuttingDown) return;
  shuttingDown = true;
  host.kill();
  wan.close();
  stop();
  process.exit(code);
};
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
host.on('exit', (code) => {
  if (smoke && !shuttingDown) {
    console.error('[smoke] host exited before smoke checks completed');
    shutdown(1);
    return;
  }
  shutdown(code ?? 0);
});

if (smoke) {
  const base = `http://127.0.0.1:${HOST_PORT}`;
  try {
    await runSmoke(base);
    console.log('[smoke] all checks passed');
    shutdown(0);
  } catch (err) {
    console.error(`[smoke] FAILED: ${err.message}`);
    shutdown(1);
  }
}

async function waitForDashboard(base) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/dashboard`);
      if (res.status === 200) return;
    } catch {
      // host not up yet
    }
    await sleep(250);
  }
  throw new Error('GET /api/dashboard did not return 200 within 30s');
}

async function runSmoke(base) {
  await waitForDashboard(base);
  console.log('[smoke] GET /api/dashboard -> 200');

  const index = await fetch(`${base}/`);
  const indexBody = await index.text();
  if (!index.ok || !indexBody.includes('demo-base.css')) {
    throw new Error(`GET / (${index.status}) does not reference demo-base.css`);
  }
  console.log('[smoke] GET / references demo-base.css');

  const gravity = await fetch(`${base}/gravity`);
  if (gravity.status !== 200) throw new Error(`GET /gravity -> ${gravity.status}`);
  console.log('[smoke] GET /gravity -> 200');

  const css = await fetch(`${base}/demo-base.css`);
  if (css.status !== 200) throw new Error(`GET /demo-base.css -> ${css.status}`);
  console.log('[smoke] GET /demo-base.css -> 200');

  const pipeline = await fetch(`${base}/api/pipeline`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'smoke test' }),
  });
  const pipelineBody = await pipeline.json().catch(() => ({}));
  if (!pipeline.ok || typeof pipelineBody.totalMs !== 'number') {
    throw new Error(`POST /api/pipeline (${pipeline.status}) did not return JSON with totalMs`);
  }
  console.log(`[smoke] POST /api/pipeline -> totalMs=${pipelineBody.totalMs.toFixed(0)}`);

  const report = await fetch(`${base}/api/report/colocated`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ limit: 3 }),
  });
  const reportBody = await report.json().catch(() => ({}));
  if (!report.ok || reportBody.spenders?.length !== 3) {
    throw new Error(`POST /api/report/colocated (${report.status}) did not return 3 spenders`);
  }
  console.log('[smoke] POST /api/report/colocated -> 3 spenders');
}
