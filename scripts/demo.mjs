// Boots every machine as its own deployment, then runs the host, which
// attaches via machinen+http addresses. Set MACHINEN_JAVA_VM=1 to skip the
// host-side Java process and boot java_machine from its machine image in a Machinen VM.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { remoteEnv, startMachines } from './machines.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const javaVm = process.env.MACHINEN_JAVA_VM === '1';

const { stop } = await startMachines({ exclude: javaVm ? ['java_machine'] : [] });

const host = spawn('node', [path.join(ROOT, 'apps/host/dist/index.js')], {
  env: {
    ...process.env,
    ...remoteEnv(javaVm ? ['compute_machine', 'python_machine'] : ['compute_machine', 'java_machine', 'python_machine']),
    ...(javaVm
      ? {
          MACHINEN_REMOTE_JAVA_MACHINE:
            `machinen://${path.join(ROOT, 'apps/remote-java/dist/java_machine.machine')}` +
            '?version=^1.0.0',
        }
      : {}),
  },
  stdio: 'inherit',
});

const code = await new Promise((resolve) => host.on('exit', resolve));
stop();
process.exit(code ?? 0);
