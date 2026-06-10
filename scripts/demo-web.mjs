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
import {
  ANALYTICS_ORIGIN_PORT,
  commandFor,
  HOST_PORT,
  localEntry,
  PORTS,
  REGION_AGENT_PORT,
  remoteEnv,
  startGuest,
  startMachines,
  WAN_AGENT_PORT,
  WAN_ORIGIN_PORT,
  WAN_PORTS,
  wanEntry,
} from './machines.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smoke = process.argv.includes('--smoke');

// eu-west starts WITHOUT analytics: scenario 2 deploys it live, by pull.
const { stop } = await startMachines({ exclude: ['analytics_machine'] });

const children = [];
const stopAll = () => {
  for (const child of children.reverse()) child.kill();
  children.length = 0;
  stop();
};

let wan;
try {
  // The analytics ORIGIN runs in us-east and publishes its artifacts; its own
  // db binding crosses the WAN (it is far from the data — that's the point).
  const origin = await startGuest({
    name: 'analytics_origin',
    command: commandFor('analytics_machine'),
    port: ANALYTICS_ORIGIN_PORT,
    env: { MACHINEN_REMOTE_DB_MACHINE: wanEntry('db_machine') },
  });
  children.push(origin.child);

  // The eu-west region agent: deploys analytics next to db_machine on demand.
  // Its pull entry reaches the origin THROUGH the WAN (the artifact transfer
  // pays region latency), and the clone's db binding re-resolves to the
  // LOCAL eu-west address at boot.
  const agent = spawn('node', [path.join(ROOT, 'apps/host/dist/region-agent.js')], {
    env: {
      ...process.env,
      AGENT_PORT: String(REGION_AGENT_PORT),
      AGENT_ANALYTICS_ENTRY:
        `machinen+pull+http://127.0.0.1:${WAN_ORIGIN_PORT}` +
        `?artifact=image&port=${PORTS.analytics_machine}&version=^1.0.0`,
      MACHINEN_REMOTE_DB_MACHINE: localEntry('db_machine'),
    },
    stdio: 'inherit',
  });
  children.push(agent);
  await waitForAgent(`http://127.0.0.1:${REGION_AGENT_PORT}/status`, agent);

  // Simulated WAN links into the data region: db queries, analytics calls,
  // the deploy command, and the artifact transfer ALL cross it.
  wan = await startWanLinks({
    latencyMs: 75,
    extra: [
      { port: WAN_AGENT_PORT, targetPort: REGION_AGENT_PORT },
      { port: WAN_ORIGIN_PORT, targetPort: ANALYTICS_ORIGIN_PORT },
    ],
  });
} catch (error) {
  console.error(`[demo-web] failed to start demo infrastructure: ${error.message}`);
  stopAll();
  process.exit(1);
}

const host = spawn('node', [path.join(ROOT, 'apps/host/dist/server.js')], {
  env: {
    ...process.env,
    // Everything in the data region is reached THROUGH the WAN links.
    ...remoteEnv(Object.keys(PORTS), { wan: Object.keys(WAN_PORTS) }),
    REGION_LINKS: wan.regionLinks,
    REGION_AGENT_URL: `http://127.0.0.1:${WAN_AGENT_PORT}`,
  },
  stdio: 'inherit',
});

let shuttingDown = false;
const shutdown = (code) => {
  if (shuttingDown) return;
  shuttingDown = true;
  host.kill();
  // Give the host a beat to dispose its lifecycle guests: they inherit our
  // stdio, so an orphan would wedge piped output (and hold port 3811) forever.
  setTimeout(() => {
    wan.close();
    stopAll();
    process.exit(code);
  }, 400);
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

async function waitForAgent(url, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`region agent exited (code ${child.exitCode}) before becoming ready`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  throw new Error(`region agent did not become ready at ${url}`);
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

async function postJson(base, route, body = {}) {
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`POST ${route} -> ${res.status}${data.error ? ` (${data.error})` : ''}`);
  }
  return data;
}

function expect(cond, message) {
  if (!cond) throw new Error(message);
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

  const pipelineBody = await postJson(base, '/api/pipeline', { text: 'smoke test' });
  expect(typeof pipelineBody.totalMs === 'number', 'POST /api/pipeline returned no totalMs');
  console.log(`[smoke] POST /api/pipeline -> totalMs=${pipelineBody.totalMs.toFixed(0)}`);

  // ---- lifecycle arc: boot -> freeze -> restore -> fork -> fork again ------
  const boot = await postJson(base, '/api/lifecycle/boot');
  expect(boot.phase === 'running' && boot.value === 3, `lifecycle boot: ${JSON.stringify(boot)}`);
  console.log('[smoke] lifecycle boot -> counter 3');

  const freeze = await postJson(base, '/api/lifecycle/freeze');
  expect(freeze.phase === 'snapshotted' && freeze.snapBytes > 0, 'lifecycle freeze failed');
  console.log(`[smoke] lifecycle freeze -> ${freeze.snapFile} (${freeze.snapBytes} bytes)`);

  const restore = await postJson(base, '/api/lifecycle/restore');
  expect(restore.resumed === 3 && restore.value === 4, `lifecycle restore: ${JSON.stringify(restore)}`);
  console.log('[smoke] lifecycle restore -> resumed 3, continued to 4');

  const pullA = await postJson(base, '/api/lifecycle/pull');
  expect(pullA.clone === 'a' && pullA.resumed === 4, `lifecycle pull a: ${JSON.stringify(pullA)}`);
  expect(pullA.clones.a.imageCacheHit === false && pullA.clones.a.pulledBytes > 0,
    'first pull should be an image cache MISS with bytes moved');
  const artifactWire = (pullA.wire ?? []).filter((e) => e.type === 'artifact');
  expect(artifactWire.length === 1, 'pull a should record one artifact wire event');
  console.log(`[smoke] lifecycle pull a -> resumed 4, ${pullA.clones.a.pulledBytes} bytes, image MISS`);

  const pullB = await postJson(base, '/api/lifecycle/pull');
  expect(pullB.clone === 'b' && pullB.clones.b.imageCacheHit === true,
    'second pull should be an image cache HIT');
  console.log('[smoke] lifecycle pull b -> image cache HIT');

  const bumpA = await postJson(base, '/api/lifecycle/counter', { target: 'a' });
  expect(bumpA.targetValue === 5 && bumpA.value === 4,
    `clone a increment must not touch the origin: ${JSON.stringify({ target: bumpA.targetValue, origin: bumpA.value })}`);
  const bumpOrigin = await postJson(base, '/api/lifecycle/counter', { target: 'origin' });
  expect(bumpOrigin.value === 5 && bumpOrigin.clones.a.value === 5 && bumpOrigin.clones.b.value === 4,
    'origin/clone counters should diverge independently');
  console.log('[smoke] lifecycle counters diverge: origin 5, clone a 5, clone b 4');

  const dash = await fetch(`${base}/api/dashboard`).then((r) => r.json());
  expect(dash.lifecycle?.phase === 'forked', 'dashboard lifecycle block missing/incorrect');
  expect(dash.cache?.misses >= 1 && dash.cache?.hits >= 1, 'dashboard cache block missing hook counts');
  console.log(`[smoke] dashboard lifecycle+cache blocks -> ${dash.cache.artifacts} artifacts, ` +
    `${dash.cache.hits} hits / ${dash.cache.misses} misses`);

  // ---- gravity: deploy-by-pull, then the co-located report -----------------
  const gravityState = await fetch(`${base}/api/gravity/state`).then((r) => r.json());
  expect(gravityState.agent === 'reachable', `region agent not reachable: ${JSON.stringify(gravityState)}`);
  expect(gravityState.deployed === null, 'analytics should not be deployed before the demo asks');
  console.log('[smoke] GET /api/gravity/state -> agent reachable, nothing deployed');

  const deploy = await postJson(base, '/api/gravity/deploy');
  expect(deploy.cacheHit === false && deploy.bytes > 0, `deploy should pull bytes: ${JSON.stringify(deploy)}`);
  expect(String(deploy.digest).startsWith('sha256:'), 'deploy should report the image digest');
  console.log(`[smoke] POST /api/gravity/deploy -> ${deploy.bytes} bytes, ${deploy.digest.slice(0, 19)}…, ` +
    `pull ${deploy.pullMs}ms + boot ${deploy.bootMs}ms`);

  const reportBody = await postJson(base, '/api/report/colocated', { limit: 3 });
  expect(reportBody.spenders?.length === 3, 'POST /api/report/colocated did not return 3 spenders');
  console.log('[smoke] POST /api/report/colocated -> 3 spenders (against the deployed clone)');

  const redeploy = await postJson(base, '/api/gravity/deploy');
  expect(redeploy.alreadyDeployed === true, 'second deploy should be idempotent');
  console.log('[smoke] second deploy -> alreadyDeployed');
}
