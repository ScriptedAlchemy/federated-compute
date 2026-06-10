// Boots every machine as its own deployment, then runs the host, which
// attaches purely via machinen+http addresses. Federation is the multiplexer.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { remoteEnv, startMachines } from './machines.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = process.env.MACHINEN_TOKEN ?? 'dev-secret';

const { stop } = await startMachines({ token });

const host = spawn('node', [path.join(ROOT, 'apps/host/dist/index.js')], {
  env: {
    ...process.env,
    MACHINEN_TOKEN: token,
    ...remoteEnv(['compute_machine', 'java_machine', 'python_machine']),
  },
  stdio: 'inherit',
});

const code = await new Promise((resolve) => host.on('exit', resolve));
stop();
process.exit(code ?? 0);
