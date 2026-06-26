// Interactive web demo: machines run as separate deployments, the host serves
// a dashboard at http://localhost:3800 where every button is a federated
// machine call. Ctrl-C stops everything.
//
// `--smoke` runs a headless check pass against the running stack and exits.
import { spawn } from 'node:child_process';
import http from 'node:http';
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
const javaVm = process.env.MACHINEN_JAVA_VM === '1';
const machineNames = Object.keys(PORTS);
const hostRemoteNames = javaVm
  ? machineNames.filter((name) => name !== 'java_machine')
  : machineNames;

// eu-west starts WITHOUT analytics: scenario 2 deploys it live, by pull.
const { machines, stop } = await startMachines({
  exclude: ['analytics_machine', ...(javaVm ? ['java_machine'] : [])],
});

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
    ...remoteEnv(hostRemoteNames, { wan: Object.keys(WAN_PORTS) }),
    ...(javaVm ? { MACHINEN_JAVA_VM: '1' } : {}),
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
const RESPAWN_BASE_DELAY_MS = 1500;
const RESPAWN_MAX_DELAY_MS = 30_000;

function supervise(machine) {
  // Exponential backoff: a crash-looping machine must not hammer respawns at
  // full speed forever. The delay doubles per respawn (capped) and resets to
  // base only once a respawn reaches healthy.
  let respawnDelayMs = RESPAWN_BASE_DELAY_MS;
  const watch = (child) => {
    child.on('exit', (code, signal) => {
      if (shuttingDown) return;
      const delayMs = respawnDelayMs;
      respawnDelayMs = Math.min(respawnDelayMs * 2, RESPAWN_MAX_DELAY_MS);
      console.log(
        `[supervisor] ${machine.name} exited (${signal ?? `code ${code}`}) — respawning in ${delayMs}ms`,
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
          .then(() => {
            respawnDelayMs = RESPAWN_BASE_DELAY_MS;
            console.log(`[supervisor] ${machine.name} is back on :${machine.port}`);
          })
          .catch((error) => console.error(`[supervisor] ${error.message}`));
      }, delayMs);
    });
  };
  watch(machine.child);
}

// compute_machine is the chaos demo's victim; it gets supervised respawn.
const chaosVictim = machines.find((machine) => machine.name === 'compute_machine');
if (!chaosVictim) throw new Error('compute_machine missing from started machines — chaos demo needs it');
supervise(chaosVictim);

// Failure-mode smoke ports: declared before the smoke pass runs (consts in
// the section below would still be in their temporal dead zone).
const FAILURE_HOST_PORT = 3950;
const FAILURE_STUB_PORT = 3951;
const FAILURE_SNAP_PORT = 3957;
const FAILURE_TYPES_CAP = 1024 * 1024; // the host's MAX_TYPES_BYTES

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

  const fluid = await fetch(`${base}/fluid`);
  const fluidBody = await fluid.text();
  if (fluid.status !== 200 || !fluidBody.includes('demo-base.js')) {
    throw new Error(`GET /fluid (${fluid.status}) does not reference demo-base.js`);
  }
  console.log('[smoke] GET /fluid -> 200, references demo-base.js');

  const android = await fetch(`${base}/android`);
  const androidBody = await android.text();
  if (android.status !== 200 || !androidBody.includes('demo-base.js')) {
    throw new Error(`GET /android (${android.status}) does not reference demo-base.js`);
  }
  // The android lab must report status without touching KVM or the machinen
  // runtime — the page has to load on hosts that can't run the arc.
  const androidStatus = await fetch(`${base}/api/android/status`);
  const androidState = await androidStatus.json();
  if (androidStatus.status !== 200 || androidState.phase !== 'cold') {
    throw new Error(
      `GET /api/android/status -> ${androidStatus.status}, phase "${androidState.phase}" (expected cold)`,
    );
  }
  console.log(`[smoke] GET /android -> 200, lab status cold (kvm=${androidState.kvm})`);

  const screen = await fetch(`${base}/screen`);
  const screenBody = await screen.text();
  if (screen.status !== 200 || !screenBody.includes('demo-base.js')) {
    throw new Error(`GET /screen (${screen.status}) does not reference demo-base.js`);
  }
  console.log('[smoke] GET /screen -> 200, references demo-base.js');

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

  const fluidLocal = await postJson(base, '/api/fluid/query', {
    query: 'smoke the fluid function locally',
    policy: 'local',
    callerRegion: 'us-east',
  });
  expect(fluidLocal.decision?.mode === 'local',
    `fluid local query should stay at origin: ${JSON.stringify(fluidLocal.decision)}`);
  expect(fluidLocal.originModule === 'compute_machine/fluid',
    `fluid local query should use the normal origin module: ${JSON.stringify(fluidLocal)}`);
  console.log(`[smoke] POST /api/fluid/query local -> ${fluidLocal.decision.replica}`);

  const fluidPrepared = await postJson(base, '/api/fluid/prepare');
  expect(fluidPrepared.phase === 'prepared',
    `fluid prepare should publish a prepared vmstate: ${JSON.stringify(fluidPrepared)}`);
  expect(String(fluidPrepared.published?.digest).startsWith('sha256:'),
    `fluid prepare should publish a digest: ${JSON.stringify(fluidPrepared.published)}`);
  console.log(`[smoke] POST /api/fluid/prepare -> ${fluidPrepared.published.bytes} bytes, ` +
    `${fluidPrepared.published.digest.slice(0, 19)}…`);

  const fluidBodyJson = await postJson(base, '/api/fluid/query', {
    query: 'ship this function across regions and stream the answer back',
    policy: 'distribute',
    callerRegion: 'us-east',
  });
  expect(fluidBodyJson.decision?.mode === 'distribute',
    `fluid query should choose distribute: ${JSON.stringify(fluidBodyJson.decision)}`);
  expect(fluidBodyJson.decision?.connection?.state === 'opened',
    `fluid query should open a back-channel: ${JSON.stringify(fluidBodyJson.decision?.connection)}`);
  expect(fluidBodyJson.decision?.connection?.kind === 'host-mediated-backhaul',
    `fluid query should report the actual backhaul mode: ${JSON.stringify(fluidBodyJson.decision?.connection)}`);
  expect(fluidBodyJson.restore?.artifact === 'vmstate',
    `fluid query should restore vmstate, not cold boot image: ${JSON.stringify(fluidBodyJson.restore)}`);
  expect(decodeURIComponent(String(fluidBodyJson.restore.entry)).includes(`digest=${fluidPrepared.published.digest}`),
    `fluid query should pin the prepared vmstate digest: ${JSON.stringify(fluidBodyJson.restore)}`);
  expect((fluidBodyJson.timeline ?? []).map((s) => s.kind).join(',') ===
    'query,invoke,decide,restore,connect,return',
    `fluid timeline malformed: ${JSON.stringify(fluidBodyJson.timeline)}`);
  expect((fluidBodyJson.wire ?? []).some((e) => e.type === 'artifact' && e.artifact === 'vmstate'),
    'fluid query should include real vmstate pull wire evidence');
  console.log(`[smoke] POST /api/fluid/query distribute -> ${fluidBodyJson.decision.connection.from} ` +
    `-> ${fluidBodyJson.decision.connection.to}`);

  const fluidAdaptive = await postJson(base, '/api/fluid/adapt', {
    hotRegion: 'eu-west',
    requestCount: 32,
  });
  expect(fluidAdaptive.migration?.atRequest === 8,
    `adaptive fluid burst should migrate after sustained heat: ${JSON.stringify(fluidAdaptive.migration)}`);
  expect(fluidAdaptive.finalRegion === 'eu-west' && fluidAdaptive.savedMs > 0,
    `adaptive fluid burst should pay back colocating compute: ${JSON.stringify(fluidAdaptive)}`);
  console.log(`[smoke] POST /api/fluid/adapt -> moved at request ${fluidAdaptive.migration.atRequest}, ` +
    `saved ${Math.round(fluidAdaptive.savedMs)}ms`);

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

  // ---- whole-VM lane: capability honesty + replay availability -------------
  const cap = await fetch(`${base}/api/vm/capability`).then((r) => r.json());
  expect(typeof cap.available === 'boolean' && typeof cap.reason === 'string',
    `vm capability malformed: ${JSON.stringify(cap)}`);
  console.log(`[smoke] GET /api/vm/capability -> ${cap.reason}`);
  expect(dash.vm?.phase !== undefined, 'dashboard vm block missing');

  const replayRes = await fetch(`${base}/api/vm/replay`);
  expect(replayRes.status === 200, `GET /api/vm/replay -> ${replayRes.status} (fixture missing?)`);
  const replay = await replayRes.json();
  expect(replay.format === 'vm-demo-trace@1' && replay.events.length >= 10,
    'replay trace malformed or too short');
  console.log(`[smoke] GET /api/vm/replay -> ${replay.events.length} events (${replay.platform})`);

  if (!cap.available) {
    const refused = await fetch(`${base}/api/vm/boot`, { method: 'POST' });
    expect(refused.status === 503, `vm boot without KVM must refuse with 503, got ${refused.status}`);
    console.log('[smoke] POST /api/vm/boot honestly refuses without KVM');
  }

  // ---- opt-in live VM arc (KVM box + SMOKE_VM_LIVE=1; ~45s of real VMs) ----
  if (cap.available && process.env.SMOKE_VM_LIVE === '1') {
    const vmBoot = await postJson(base, '/api/vm/boot');
    expect(vmBoot.phase === 'running' && vmBoot.progress.iteration >= 0
      && vmBoot.timings.bootMs > 0, `vm boot failed: ${JSON.stringify(vmBoot.timings)}`);
    await sleep(1500); // let the solver visibly work before the freeze
    const pub = await postJson(base, '/api/vm/publish');
    expect(String(pub.published.digest).startsWith('sha256:') && pub.published.bytes > 0,
      `vm publish: ${JSON.stringify(pub.published)}`);
    const restore = await postJson(base, '/api/vm/restore');
    expect(restore.progress.iteration >= restore.frozenAt.iteration,
      `restored VM lost heap: ${restore.progress.iteration} < ${restore.frozenAt.iteration}`);
    expect(restore.pull.bytes > 0 && restore.pull.cacheHit === false,
      'first vmstate pull must move bytes');
    await postJson(base, '/api/vm/reset');
    console.log(`[smoke] live VM arc: boot ${vmBoot.timings.bootMs}ms, ` +
      `publish ${pub.published.publishMs}ms (source dead: ${pub.published.sourceDead}), ` +
      `pull ${restore.pull.ms}ms, pull+restore+first call ${restore.timings.restoreMs}ms`);
  }

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

  await runFailureModeSmoke();
}

// ---- deterministic failure modes ---------------------------------------------
// Runs against its OWN host instance + a hostile origin stub on ports far from
// the demo range (3800-3812), so the main stack and its teardown are untouched.
// Leg 1 proves the streamed /api/types buffer cap; leg 2 proves a failed boot
// leaves the lifecycle coherently 'cold' (the dead-origin pull fails fast).
function startHostileStub() {
  const stub = http.createServer((req, res) => {
    // The consumer aborts mid-stream by design — never crash on the reset.
    res.on('error', () => {});
    req.socket.on('error', () => {});
    const url = req.url ?? '';
    if (url.startsWith('/mf-manifest.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ protocol: 3, version: '1.0.0', exposes: {} }));
    }
    if (url.startsWith('/mf-types.ts')) {
      // Chunked transfer (no content-length): stream to twice the host's
      // buffer cap, so only the cap itself can stop the relay.
      res.writeHead(200, { 'content-type': 'application/typescript' });
      const chunk = Buffer.alloc(64 * 1024, '// hostile filler that never ends\n');
      let sent = 0;
      const push = () => {
        while (sent < 2 * FAILURE_TYPES_CAP) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once('drain', push);
        }
        res.end();
      };
      return push();
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve, reject) => {
    stub.once('error', reject);
    stub.listen(FAILURE_STUB_PORT, '127.0.0.1', () => resolve(stub));
  });
}

async function runFailureModeSmoke() {
  const base = `http://127.0.0.1:${FAILURE_HOST_PORT}`;
  const stub = await startHostileStub();
  // Isolated host: java_machine points at the hostile stub; the lifecycle
  // image origin points at the stub's address too, which leg 2 turns into a
  // dead port by killing the stub first.
  const altHost = spawn('node', [path.join(ROOT, 'apps/host/dist/server.js')], {
    env: {
      ...process.env,
      HOST_PORT: String(FAILURE_HOST_PORT),
      SNAPSHOT_PORT: String(FAILURE_SNAP_PORT),
      MACHINEN_REMOTE_JAVA_MACHINE: `machinen+http://127.0.0.1:${FAILURE_STUB_PORT}?version=^1.0.0`,
      SNAPSHOT_IMAGE_SOURCE: `http://127.0.0.1:${FAILURE_STUB_PORT}`,
    },
    stdio: 'inherit',
  });
  try {
    await waitForHttpOk(`${base}/api/dashboard`, {
      child: altHost,
      what: 'failure-mode host',
      timeoutMs: 10_000,
    });

    // Leg 1 — streamed cap: the stub's chunked /mf-types.ts must be cut off
    // at the host's buffer cap, not relayed or buffered whole.
    const types = await fetch(`${base}/api/types?machine=java_machine`, {
      signal: AbortSignal.timeout(8_000),
    });
    const typesBody = await types.json().catch(() => ({}));
    expect(types.status === 502,
      `oversized /mf-types.ts should be a 502 (got ${types.status}: ${JSON.stringify(typesBody).slice(0, 120)})`);
    expect(String(typesBody.error).includes('exceeds'),
      `502 should carry the exceeds-cap error (got ${JSON.stringify(typesBody.error)})`);
    console.log('[smoke] failure mode: chunked >1MB /mf-types.ts -> 502 exceeds-cap');

    // Leg 2 — coherent boot failure: kill the stub, so the lifecycle origin
    // pull hits a dead port. The boot must fail AND leave the phase 'cold'.
    await new Promise((resolve) => {
      stub.close(resolve);
      stub.closeAllConnections(); // keep-alive sockets must not stall the close
    });
    const boot = await fetch(`${base}/api/lifecycle/boot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(8_000),
    });
    expect(!boot.ok, `boot against a dead origin should fail (got ${boot.status})`);
    const dash = await fetch(`${base}/api/dashboard`, { signal: AbortSignal.timeout(8_000) })
      .then((r) => r.json());
    expect(dash.lifecycle?.phase === 'cold',
      `failed boot should leave lifecycle phase 'cold' (got ${JSON.stringify(dash.lifecycle?.phase)})`);
    console.log("[smoke] failure mode: dead-origin boot -> non-200, lifecycle stays 'cold'");
  } finally {
    altHost.kill();
    stub.closeAllConnections();
    stub.close(() => {}); // noop callback swallows ERR_SERVER_NOT_RUNNING from leg 2's close
    // The alt host must be gone before we return: an orphan would inherit our
    // stdio and hold its port. SIGKILL fallback keeps teardown bounded.
    await Promise.race([
      new Promise((resolve) => altHost.once('exit', resolve)),
      sleep(2_000).then(() => altHost.kill('SIGKILL')),
    ]);
  }
}
