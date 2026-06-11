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
  spawnMachineProcess,
  startGuest,
  startMachines,
  waitForHttpOk,
  WAN_AGENT_PORT,
  WAN_ORIGIN_PORT,
  WAN_PORTS,
  wanEntry,
} from './machines.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smoke = process.argv.includes('--smoke');

// eu-west starts WITHOUT analytics: scenario 2 deploys it live, by pull.
const { machines, stop } = await startMachines({ exclude: ['analytics_machine'] });

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
  await waitForHttpOk(`http://127.0.0.1:${REGION_AGENT_PORT}/status`, {
    child: agent,
    what: 'region agent',
  });

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

// ---- deployment supervisor ---------------------------------------------------
// The host must never restart somebody else's deployment (containment) — but
// this orchestrator owns the machine processes it spawned, so it supervises
// them: when the chaos demo kills compute_machine, the supervisor respawns it
// after a beat and the host's next call re-attaches. `machine.child` is kept
// pointing at the live process so stopAll()/stop() always kill the current one.
const RESPAWN_DELAY_MS = 1500;

function supervise(machine) {
  const watch = (child) => {
    child.on('exit', (code, signal) => {
      if (shuttingDown) return;
      console.log(
        `[supervisor] ${machine.name} exited (${signal ?? `code ${code}`}) — respawning in ${RESPAWN_DELAY_MS}ms`,
      );
      setTimeout(() => {
        if (shuttingDown) return;
        const next = spawnMachineProcess(machine);
        machine.child = next;
        watch(next);
        waitForHttpOk(`http://127.0.0.1:${machine.port}/mf/health`, {
          child: next,
          what: `${machine.name} respawn`,
        })
          .then(() => console.log(`[supervisor] ${machine.name} is back on :${machine.port}`))
          .catch((error) => console.error(`[supervisor] ${error.message}`));
      }, RESPAWN_DELAY_MS);
    });
  };
  watch(machine.child);
}

// compute_machine is the chaos demo's victim; it gets supervised respawn.
const chaosVictim = machines.find((machine) => machine.name === 'compute_machine');
if (!chaosVictim) throw new Error('compute_machine missing from started machines — chaos demo needs it');
supervise(chaosVictim);

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
  await waitForHttpOk(`${base}/api/dashboard`, { what: 'host dashboard' });
  console.log('[smoke] GET /api/dashboard -> 200');

  const index = await fetch(`${base}/`);
  const indexBody = await index.text();
  if (!index.ok || !indexBody.includes('demo-base.css') || !indexBody.includes('demo-base.js')) {
    throw new Error(`GET / (${index.status}) does not reference demo-base.css + demo-base.js`);
  }
  console.log('[smoke] GET / references demo-base.css + demo-base.js');

  const gravity = await fetch(`${base}/gravity`);
  const gravityBody = await gravity.text();
  if (gravity.status !== 200 || !gravityBody.includes('demo-base.js')) {
    throw new Error(`GET /gravity (${gravity.status}) does not reference demo-base.js`);
  }
  console.log('[smoke] GET /gravity -> 200, references demo-base.js');

  const css = await fetch(`${base}/demo-base.css`);
  if (css.status !== 200) throw new Error(`GET /demo-base.css -> ${css.status}`);
  const sharedJs = await fetch(`${base}/demo-base.js`);
  if (sharedJs.status !== 200 || !sharedJs.headers.get('content-type')?.includes('javascript')) {
    throw new Error(
      `GET /demo-base.js -> ${sharedJs.status} (${sharedJs.headers.get('content-type')})`,
    );
  }
  console.log('[smoke] GET /demo-base.css + /demo-base.js -> 200');

  const pipelineBody = await postJson(base, '/api/pipeline', { text: 'smoke test' });
  expect(typeof pipelineBody.totalMs === 'number', 'POST /api/pipeline returned no totalMs');
  console.log(`[smoke] POST /api/pipeline -> totalMs=${pipelineBody.totalMs.toFixed(0)}`);

  // ---- lifecycle arc: boot -> freeze -> restore -> fork -> fork again ------
  // 100% HTTP: the origin's image is pulled from compute_machine's /mf-image
  // at boot (the host never reads machine code from disk) — that pull is the
  // run's one image MISS; every later pull is a digest HIT.
  const boot = await postJson(base, '/api/lifecycle/boot');
  expect(boot.phase === 'running' && boot.value === 3, `lifecycle boot: ${JSON.stringify(boot)}`);
  const bootPull = (boot.wire ?? []).find((e) => e.type === 'artifact');
  expect(bootPull && bootPull.cacheHit === false && bootPull.bytes > 0,
    `boot should pull the origin image over HTTP (MISS): ${JSON.stringify(bootPull)}`);
  console.log(`[smoke] lifecycle boot -> image pulled over HTTP (${bootPull.bytes} bytes, MISS), counter 3`);

  const freeze = await postJson(base, '/api/lifecycle/freeze');
  expect(freeze.phase === 'snapshotted' && freeze.snapBytes > 0, 'lifecycle freeze failed');
  console.log(`[smoke] lifecycle freeze -> ${freeze.snapFile} (${freeze.snapBytes} bytes)`);

  const restore = await postJson(base, '/api/lifecycle/restore');
  expect(restore.resumed === 3 && restore.value === 4, `lifecycle restore: ${JSON.stringify(restore)}`);
  console.log('[smoke] lifecycle restore -> resumed 3, continued to 4');

  const pullA = await postJson(base, '/api/lifecycle/pull');
  expect(pullA.clone === 'a' && pullA.resumed === 4, `lifecycle pull a: ${JSON.stringify(pullA)}`);
  expect(pullA.clones.a.imageCacheHit === true,
    'fork pull should be an image cache HIT — the image already crossed the wire at boot');
  expect(pullA.clones.a.pulledBytes > 0, 'fork pull should move the snapshot bytes');
  const artifactWire = (pullA.wire ?? []).filter((e) => e.type === 'artifact');
  expect(artifactWire.length === 1, 'pull a should record one artifact wire event');
  console.log(`[smoke] lifecycle pull a -> resumed 4, ${pullA.clones.a.pulledBytes} bytes, image HIT`);

  expect(String(pullA.imageDigest).startsWith('sha256:'),
    `pull a should learn the image digest from the clone manifest (got ${pullA.imageDigest})`);

  const pullB = await postJson(base, '/api/lifecycle/pull');
  expect(pullB.clone === 'b' && pullB.clones.b.imageCacheHit === true,
    'second pull should be an image cache HIT');
  expect(pullB.clones.b.pinnedDigest === pullA.imageDigest,
    `pull b should pin the digest learned in step 4: ${JSON.stringify({
      pinned: pullB.clones.b.pinnedDigest, learned: pullA.imageDigest,
    })}`);
  expect(pullB.clones.b.entry.includes(`digest=${pullA.imageDigest}`),
    `clone b entry should carry the ?digest= pin (got ${pullB.clones.b.entry})`);
  console.log(`[smoke] lifecycle pull b -> image cache HIT, entry pinned ${pullB.clones.b.pinnedDigest.slice(0, 19)}…`);

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

  // ---- latency honesty: each report is stamped with the WAN latency it paid
  await postJson(base, '/api/region/latency', { ms: 50 });
  const remoteAt50 = await postJson(base, '/api/report/remote', { limit: 3 });
  expect(remoteAt50.wanLatencyMs === 50,
    `cross-region report should be stamped wanLatencyMs=50 (got ${remoteAt50.wanLatencyMs})`);
  await postJson(base, '/api/region/latency', { ms: 100 });
  const coloAt100 = await postJson(base, '/api/report/colocated', { limit: 3 });
  expect(coloAt100.wanLatencyMs === 100,
    `co-located report should be stamped wanLatencyMs=100 (got ${coloAt100.wanLatencyMs})`);
  await postJson(base, '/api/region/latency', { ms: 75 }); // restore the default
  console.log('[smoke] report latency stamps -> remote at 50ms, colocated at 100ms');

  // ---- typed-imports surface: the machine's own /mf-types.ts, proxied ------
  const types = await fetch(`${base}/api/types?machine=java_machine`).then((r) => r.json());
  expect(typeof types.types === 'string' && types.types.includes('export'),
    `GET /api/types should proxy the machine's TS bindings: ${JSON.stringify(types).slice(0, 120)}`);
  const badTypes = await fetch(`${base}/api/types?machine=nope`);
  expect(badTypes.status === 400, `unknown machine should be a 400 (got ${badTypes.status})`);
  console.log('[smoke] GET /api/types?machine=java_machine -> typed bindings proxied');

  // ---- version negotiation: demanding ^2.0.0 must be refused, repeatably ---
  for (const attempt of [1, 2]) {
    const demand = await postJson(base, '/api/version/demand');
    expect(demand.rejected === true, `version demand ${attempt} should be rejected: ${JSON.stringify(demand)}`);
    expect(demand.errorName === 'MachineVersionError',
      `rejection should be a MachineVersionError (got ${demand.errorName})`);
    expect(String(demand.error).includes('^2.0.0'), 'rejection error should carry the required range');
    expect((demand.wire ?? []).some((e) => e.type === 'reject'),
      'version demand wire should carry the reject event');
    if (attempt === 1) {
      expect(typeof demand.reported === 'string' && demand.reported.length > 0,
        'rejection should report the version the manifest actually carries');
    }
  }
  console.log('[smoke] POST /api/version/demand -> MachineVersionError, twice (repeatable)');

  // ---- chaos: kill compute_machine, watch the breaker open, wait for heal --
  // Runs LAST: the machine is dead/failing-fast for ~12s (respawn + breaker
  // reset window) and nothing after this may depend on it.
  const kill = await postJson(base, '/api/chaos/kill');
  expect(kill.burst?.failed >= 5, `chaos burst should fail >=5 calls: ${JSON.stringify(kill.burst)}`);
  expect(kill.circuitOpened === true, 'chaos kill should open the circuit breaker');
  const killWire = (kill.wire ?? []).map((e) => e.type);
  expect(killWire.includes('crash') && killWire.includes('circuit'),
    `chaos wire should carry crash + circuit hook events (got ${killWire.join(',')})`);
  console.log(`[smoke] POST /api/chaos/kill -> ${kill.burst.failed}/${kill.burst.attempted} burst calls failed, circuit open`);

  const healDeadline = Date.now() + 30_000;
  let sawFailFast = false;
  let probe;
  for (;;) {
    probe = await postJson(base, '/api/chaos/probe');
    if (probe.recovered) break;
    if (probe.errorName === 'MachineCircuitOpenError') sawFailFast = true;
    if (Date.now() > healDeadline) {
      throw new Error(`chaos recovery timed out: ${JSON.stringify(probe)}`);
    }
    await sleep(1000);
  }
  expect(typeof probe.value === 'number', 'recovered chaos probe should carry the counter value');
  expect(sawFailFast, 'dead-window probes should fail fast with MachineCircuitOpenError');
  const healedDash = await fetch(`${base}/api/dashboard`).then((r) => r.json());
  expect(healedDash.machines.find((m) => m.name === 'compute_machine')?.attached === true,
    'compute_machine should be re-attached after chaos recovery');
  console.log(`[smoke] chaos recovery -> circuit closed, machine re-attached, counter at ${probe.value}`);
}
