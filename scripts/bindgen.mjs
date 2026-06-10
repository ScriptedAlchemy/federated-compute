// Orchestrator only: stand in for "the machines are deployed somewhere" by
// booting them, then run the HOST'S OWN bindgen, which pulls types purely
// over the network from those addresses. The host never reads other apps'
// source — in separate repos you'd skip this script and point
// `pnpm --filter host bindgen` at real deployed URLs.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { remoteEnv, startMachines } from './machines.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = process.env.MACHINEN_TOKEN ?? 'bindgen-secret';

const { stop } = await startMachines({ token });
try {
  const code = await new Promise((resolve) => {
    const child = spawn('pnpm', ['--filter', 'host', 'bindgen', ...process.argv.slice(2)], {
      cwd: ROOT,
      env: {
        ...process.env,
        MACHINEN_TOKEN: token,
        ...remoteEnv(),
      },
      stdio: 'inherit',
    });
    child.on('exit', resolve);
  });
  // Don't process.exit() here: it would skip the finally and orphan the
  // machines. Set the exit code and fall through to stop().
  if (code !== 0) process.exitCode = code ?? 1;
} finally {
  stop();
}
