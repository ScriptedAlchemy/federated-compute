// Dev orchestrator: stands in for each machine's own deployment. Every guest
// is booted as an independent service — the host only ever sees addresses.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MACHINES = [
  {
    name: 'compute_machine',
    port: 3801,
    command: ['node', path.join(ROOT, 'apps/remote/dist/index.js')],
  },
  {
    name: 'java_machine',
    port: 3802,
    command: ['java', '-jar', path.join(ROOT, 'apps/remote-java/dist/java-machine.jar')],
  },
  {
    name: 'python_machine',
    port: 3803,
    command: ['python3', path.join(ROOT, 'apps/remote-python/main.py')],
  },
  {
    name: 'db_machine',
    port: 3804,
    command: ['node', path.join(ROOT, 'apps/machine-db/src/index.mjs')],
  },
  {
    name: 'analytics_machine',
    port: 3805,
    command: ['node', path.join(ROOT, 'apps/machine-analytics/src/index.mjs')],
    // Co-located with db_machine: its db entry is the LOCAL address, no WAN.
    env: { MACHINEN_REMOTE_DB_MACHINE: 'machinen+http://127.0.0.1:3804' },
  },
];

async function waitForManifest(port, token, name) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const health = await fetch(`http://127.0.0.1:${port}/mf/health`);
      if (health.ok) {
        const res = await fetch(`http://127.0.0.1:${port}/mf-manifest.json`, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        if (res.ok) return await res.json();
      }
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  throw new Error(`machine ${name} did not become ready on :${port}`);
}

export async function startMachines({ token }) {
  const started = [];
  for (const machine of MACHINES) {
    const [cmd, ...args] = machine.command;
    const child = spawn(cmd, args, {
      env: {
        ...process.env,
        PORT: String(machine.port),
        ...(token ? { MACHINEN_TOKEN: token } : {}),
        ...(machine.env ?? {}),
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    started.push({ ...machine, child });
  }
  for (const machine of started) {
    machine.manifest = await waitForManifest(machine.port, token, machine.name);
  }
  return {
    machines: started,
    stop() {
      for (const machine of started) machine.child.kill();
    },
  };
}
