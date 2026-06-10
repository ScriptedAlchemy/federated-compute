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

// Deploy-by-pull infrastructure (web demo): the analytics ORIGIN runs in
// us-east and publishes its image; the eu-west region agent pulls it through
// the WAN and boots the clone at PORTS.analytics_machine — so the host's
// existing WAN entry (3898 -> 3805) routes to the deployed clone unchanged.
export const ANALYTICS_ORIGIN_PORT = 3806;
export const REGION_AGENT_PORT = 3810;
// Page 01 lifecycle origin: the host boots snap_machine at this fixed port so
// its machinen+pull+ entries are static (`?port=` on the image entry).
export const LIFECYCLE_PORT = 3811;

// Simulated WAN links into the data region (latency proxies in front of these).
export const WAN_PORTS = {
  db_machine: 3899,
  analytics_machine: 3898,
};
// WAN link: host -> region agent control API (the deploy command crosses once).
export const WAN_AGENT_PORT = 3897;
// WAN link: region agent -> analytics origin (the artifact pays WAN latency).
export const WAN_ORIGIN_PORT = 3896;

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
  analytics_machine: ['node', path.join(ROOT, 'apps/machine-analytics/dist/index.js')],
};

/** Command line for a machine's guest program (also used for the origin copy). */
export function commandFor(name) {
  return COMMANDS[name];
}

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

async function waitForManifest(port, name, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`machine ${name} exited (code ${child.exitCode}) before becoming ready`);
    }
    try {
      // Per-probe timeout: a stalled socket must not defeat the deadline
      // (or the exit-code check above).
      const health = await fetch(`http://127.0.0.1:${port}/mf/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (health.ok) {
        const res = await fetch(`http://127.0.0.1:${port}/mf-manifest.json`, {
          signal: AbortSignal.timeout(2_000),
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

/** Spawn one guest process and wait until it serves the protocol. */
export async function startGuest({ name, command, port, env }) {
  const [cmd, ...args] = command;
  const child = spawn(cmd, args, {
    env: { ...process.env, PORT: String(port), ...(env ?? {}) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  try {
    const manifest = await waitForManifest(port, name, child);
    return { name, port, child, manifest, stop: () => child.kill() };
  } catch (error) {
    child.kill();
    throw error;
  }
}

export async function startMachines({ exclude = [] } = {}) {
  const wanted = MACHINES.filter((machine) => !exclude.includes(machine.name));
  const started = [];
  for (const machine of wanted) {
    const [cmd, ...args] = machine.command;
    const child = spawn(cmd, args, {
      env: {
        ...process.env,
        PORT: String(machine.port),
        ...(machine.env ?? {}),
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    started.push({ ...machine, child });
  }
  try {
    for (const machine of started) {
      machine.manifest = await waitForManifest(machine.port, machine.name, machine.child);
    }
  } catch (error) {
    // Partial startup must not orphan children — they'd hold the demo ports
    // and poison the next run.
    for (const machine of started) machine.child.kill();
    throw error;
  }
  return {
    machines: started,
    stop() {
      for (const machine of started) machine.child.kill();
    },
  };
}
