// Dev orchestrator: stands in for each machine's own deployment. Every guest
// is booted as an independent service — the host only ever sees addresses.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Single source of truth for every port in the demo topology.
export const HOST_PORT = 3800;

export const PORTS = {
  compute_machine: 3801,
  java_machine: 3802,
  python_machine: 3803,
  db_machine: 3804,
  analytics_machine: 3805,
};

// Simulated WAN links into the data region (latency proxies in front of these).
export const WAN_PORTS = {
  db_machine: 3899,
  analytics_machine: 3898,
};

/** Machine entry at its real (same-region) address. */
export function localEntry(name) {
  return `machinen+http://127.0.0.1:${PORTS[name]}`;
}

/** Machine entry through the simulated WAN link in front of it. */
export function wanEntry(name) {
  return `machinen+http://127.0.0.1:${WAN_PORTS[name]}`;
}

/** MACHINEN_REMOTE_* env for a consumer; `wan` names route via WAN_PORTS. */
export function remoteEnv(names = Object.keys(PORTS), { wan = [] } = {}) {
  return Object.fromEntries(
    names.map((name) => [
      `MACHINEN_REMOTE_${name.toUpperCase()}`,
      wan.includes(name) ? wanEntry(name) : localEntry(name),
    ]),
  );
}

const COMMANDS = {
  compute_machine: ['node', path.join(ROOT, 'apps/remote/dist/index.js')],
  java_machine: ['java', '-jar', path.join(ROOT, 'apps/remote-java/dist/java-machine.jar')],
  python_machine: ['python3', path.join(ROOT, 'apps/remote-python/main.py')],
  db_machine: ['node', path.join(ROOT, 'apps/machine-db/src/index.mjs')],
  analytics_machine: ['node', path.join(ROOT, 'apps/machine-analytics/src/index.mjs')],
};

const ENV = {
  // The java guest's build publishes its static /mf-types.ts artifact here.
  java_machine: { MACHINEN_TYPES_FILE: path.join(ROOT, 'apps/remote-java/dist/mf-types.ts') },
  // Co-located with db_machine: its db entry is the LOCAL address, no WAN.
  analytics_machine: remoteEnv(['db_machine']),
};

export const MACHINES = Object.entries(PORTS).map(([name, port]) => ({
  name,
  port,
  command: COMMANDS[name],
  env: ENV[name],
}));

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
