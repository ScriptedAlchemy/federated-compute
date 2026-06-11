// Region agent — the eu-west half of "the code goes to the data".
//
// A tiny process that is itself a stock MF runtime consumer. Its entire
// deployment surface is ONE federation entry:
//
//   { name: 'analytics_machine', entry: 'machinen+pull+http://…?artifact=image' }
//
// The entry exists in config from the moment the agent starts, but the
// machine does not exist until POST /deploy makes the plugin warm() it: the
// agent pulls the analytics IMAGE from its us-east origin (through the WAN),
// verifies the sha256 digest, and boots the clone next to db_machine. The
// clone's own db binding re-resolves to the LOCAL db address at boot
// (MACHINEN_REMOTE_DB_MACHINE passes through the process driver's guest env).
// Every number the agent reports comes from the plugin's artifact hooks.
import http from 'node:http';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { createInstance } from '@module-federation/runtime';
import { machinenPlugin, processDriver } from '@federated-compute/machinen-plugin';

const PORT = Number(process.env.AGENT_PORT ?? 3810);
const MACHINE = 'analytics_machine';
// The pull entry IS the deployment: artifact=image (analytics is stateless
// code — the strict remoteEntry.js analog), ?port= fixes where the clone
// listens so the consumer-side WAN link routes to it unchanged.
const ANALYTICS_ENTRY =
  process.env.AGENT_ANALYTICS_ENTRY ??
  'machinen+pull+http://127.0.0.1:3896?artifact=image&port=3805&version=^1.0.0';
// Per-run artifact cache, wiped on start: the first deploy of every demo run
// is honestly a digest MISS.
const CACHE_DIR = path.resolve(import.meta.dirname, '../.machinen/region-cache');
await rm(CACHE_DIR, { recursive: true, force: true });

// ---- the agent's entire federation setup -----------------------------------
const plugin = machinenPlugin({ driver: processDriver(), artifactCacheDir: CACHE_DIR });
createInstance({
  name: 'region_agent_eu_west',
  remotes: [{ name: MACHINE, entry: ANALYTICS_ENTRY }],
  plugins: [plugin],
});
// -----------------------------------------------------------------------------

interface DeployReport {
  machine: string;
  entry: string;
  artifact: string;
  bytes: number;
  digest?: string;
  cacheHit: boolean;
  pullMs: number;
  bootMs: number;
  deployMs: number;
  deployedAt: string;
}

let deployed: DeployReport | undefined;
let deploying: Promise<DeployReport> | undefined;

// The artifact hooks are the agent's only data source for what moved.
let lastPull:
  | { artifact: string; bytes: number; digest?: string; cacheHit: boolean; pullMs: number }
  | undefined;
plugin.machineHooks.onArtifactFetched.on(({ resolution }) => {
  lastPull = {
    artifact: resolution.artifact,
    bytes: resolution.bytesFetched,
    digest: resolution.descriptor.digest,
    cacheHit: resolution.fromCache,
    pullMs: resolution.durationMs,
  };
  console.log(
    `[region-agent] pulled ${resolution.artifact}: ` +
      (resolution.fromCache ? 'cache HIT (0 bytes moved)' : `${resolution.bytesFetched} bytes`) +
      ` in ${resolution.durationMs}ms -> ${resolution.localPath}`,
  );
});
plugin.machineHooks.onMachineReady.on(({ spec, manifest }) => {
  console.log(
    `[region-agent] ${spec.remoteName} ready (v${manifest.version})` +
      (spec.pulledFrom ? ` — pulled from ${spec.pulledFrom}` : ''),
  );
});

function deploy(): Promise<DeployReport> {
  if (deployed) return Promise.resolve(deployed);
  if (deploying) return deploying;
  deploying = (async () => {
    const start = performance.now();
    // warm() pre-pulls the artifact and boots the machine — the preloadRemote
    // analog. After this, the entry's machine exists.
    await plugin.warm([MACHINE]);
    const deployMs = Math.round(performance.now() - start);
    // No fallbacks: every first deploy pulls, so a missing artifact hook
    // event is a real bug — fabricated "0 bytes" stats would lie to the UI.
    const pull = lastPull;
    if (!pull) throw new Error(`deploy of "${MACHINE}" produced no artifact hook event`);
    deployed = {
      machine: MACHINE,
      entry: ANALYTICS_ENTRY,
      artifact: pull.artifact,
      bytes: pull.bytes,
      digest: pull.digest,
      cacheHit: pull.cacheHit,
      pullMs: pull.pullMs,
      bootMs: Math.max(0, deployMs - pull.pullMs),
      deployMs,
      deployedAt: new Date().toISOString(),
    };
    return deployed;
  })();
  deploying.catch(() => {
    deploying = undefined; // a failed deploy may be retried
  });
  return deploying;
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/status') {
      return send(res, 200, {
        agent: 'region-agent',
        region: 'eu-west',
        entry: ANALYTICS_ENTRY,
        deployed: deployed ?? null,
      });
    }
    if (req.method === 'POST' && req.url === '/deploy') {
      const already = deployed !== undefined;
      const report = await deploy();
      return send(res, 200, { ...report, alreadyDeployed: already });
    }
    send(res, 404, { error: 'not found' });
  } catch (error) {
    send(res, 502, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[region-agent] eu-west control API on 127.0.0.1:${PORT}`);
  console.log(`[region-agent] analytics entry (not yet booted): ${ANALYTICS_ENTRY}`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void plugin
      .disposeMachines()
      .catch(() => {})
      .finally(() => server.close(() => process.exit(0)));
  });
}
