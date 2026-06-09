// Interactive web demo: machines run as separate deployments, the host serves
// a dashboard at http://localhost:3800 where every button is a federated
// machine call. Ctrl-C stops everything.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMachines } from './machines.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = process.env.MACHINEN_TOKEN ?? 'dev-secret';

const { stop } = await startMachines({ token });

const host = spawn('node', [path.join(ROOT, 'apps/host/dist/server.js')], {
  env: {
    ...process.env,
    MACHINEN_TOKEN: token,
    MACHINEN_REMOTE_COMPUTE_MACHINE: 'machinen+http://127.0.0.1:3801',
    MACHINEN_REMOTE_JAVA_MACHINE: 'machinen+http://127.0.0.1:3802',
    MACHINEN_REMOTE_PYTHON_MACHINE: 'machinen+http://127.0.0.1:3803',
  },
  stdio: 'inherit',
});

const shutdown = () => {
  host.kill();
  stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
host.on('exit', (code) => {
  stop();
  process.exit(code ?? 0);
});
