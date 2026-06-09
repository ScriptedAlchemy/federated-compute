// Interactive web demo: machines run as separate deployments, the host serves
// a dashboard at http://localhost:3800 where every button is a federated
// machine call. Ctrl-C stops everything.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLatencyProxy } from './latency-proxy.mjs';
import { startMachines } from './machines.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = process.env.MACHINEN_TOKEN ?? 'dev-secret';

const { stop } = await startMachines({ token });
// Simulated WAN links into the data region: BOTH paths cross it — querying
// the db directly, and calling the co-located analytics machine.
const wanDb = await startLatencyProxy({ port: 3899, targetPort: 3804, latencyMs: 75 });
const wanAnalytics = await startLatencyProxy({ port: 3898, targetPort: 3805, latencyMs: 75 });

const host = spawn('node', [path.join(ROOT, 'apps/host/dist/server.js')], {
  env: {
    ...process.env,
    MACHINEN_TOKEN: token,
    MACHINEN_REMOTE_COMPUTE_MACHINE: 'machinen+http://127.0.0.1:3801',
    MACHINEN_REMOTE_JAVA_MACHINE: 'machinen+http://127.0.0.1:3802',
    MACHINEN_REMOTE_PYTHON_MACHINE: 'machinen+http://127.0.0.1:3803',
    // Everything in the data region is reached THROUGH the WAN links.
    MACHINEN_REMOTE_DB_MACHINE: 'machinen+http://127.0.0.1:3899',
    MACHINEN_REMOTE_ANALYTICS_MACHINE: 'machinen+http://127.0.0.1:3898',
    REGION_LINKS: 'http://127.0.0.1:3899,http://127.0.0.1:3898',
  },
  stdio: 'inherit',
});

const shutdown = () => {
  host.kill();
  wanDb.close();
  wanAnalytics.close();
  stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
host.on('exit', (code) => {
  stop();
  process.exit(code ?? 0);
});
