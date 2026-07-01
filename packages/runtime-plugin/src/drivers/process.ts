import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { MachineDriver, MachineHandle, MachineSpec } from '../types.js';
import { httpMachineHandle } from './http.js';

export type BootCommandMap = Record<string, (image: string) => string[]>;

const BUILTIN_COMMANDS: BootCommandMap = {
  '.js': (image) => [process.execPath, image],
  '.mjs': (image) => [process.execPath, image],
  '.cjs': (image) => [process.execPath, image],
  '.java': (image) => ['java', image],
  '.jar': (image) => ['java', '-jar', image],
  '.py': (image) => ['python3', image],
};

/** Map an image path to the command that boots it, by file extension. */
export function resolveBootCommand(image: string, overrides: BootCommandMap = {}): string[] {
  const ext = path.extname(image);
  const factory = overrides[ext] ?? BUILTIN_COMMANDS[ext];
  if (!factory) {
    const known = [...new Set([...Object.keys(BUILTIN_COMMANDS), ...Object.keys(overrides)])];
    throw new Error(
      `[machinen-plugin] no boot command for image "${image}" (known types: ${known.join(', ')})`,
    );
  }
  return factory(image);
}

// Not ".json": MF's snapshot handler would treat the entry as a manifest URL
// and fetch it before our loadEntry hook can claim it.
const SNAP_SUFFIX = '.snap';
// Keep explicit child-process ports away from OS-assigned listen(0) ports.
// Linux defaults its ephemeral range to 32768+, and our tests spin up many
// listen(0) HTTP servers in parallel with process guests.
const RESERVED_PORT_MIN = 20_000;
const RESERVED_PORT_MAX = 32_000;
const PORT_PROBE_ATTEMPTS = 100;

interface SnapshotBundle {
  name: string;
  image: string;
  state: unknown;
  createdAt: string;
}

export interface ProcessDriverOptions {
  commands?: BootCommandMap;
  /** Where handle.snapshot() writes bundles. Default: .machinen/snapshots */
  snapshotDir?: string;
  /** Extra environment variables for the guest, merged over the allowlist. */
  env?: Record<string, string>;
}

// Guests get an allowlisted environment, not the host's full env: the host
// process may carry cloud credentials, CI secrets, etc. that a guest has no
// business reading. MACHINEN_* vars pass through as the protocol's own
// configuration convention.
const HOST_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP',
  'LANG', 'LC_ALL', 'TZ', 'JAVA_HOME', 'PYTHONHOME', 'PYTHONPATH',
  'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT',
];

/** Build the allowlisted environment a spawned guest receives. */
export function buildGuestEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of HOST_ENV_ALLOWLIST) {
    if (base[key] !== undefined) env[key] = base[key];
  }
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith('MACHINEN_') && value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Driver that boots the machine guest as a local child process — the
 * lightweight local driver for dev and tests, alongside `machinenDriver()`
 * (real microVMs, whole-VM snapshots). The entry's image is the guest program
 * (`.js`/`.java`/`.jar`/`.py`...). `handle.snapshot()` freezes the guest's
 * app state (via `GET /mf/state`) into a `.snap` bundle that remembers its
 * image; booting a `machinen://*.snap` entry restores instead of cold-booting.
 */
export function processDriver(opts: ProcessDriverOptions = {}): MachineDriver {
  const snapshotDir = opts.snapshotDir ?? path.join('.machinen', 'snapshots');

  async function bootProcess(spec: MachineSpec, image: string, restoreState?: unknown) {
    const port = Number(spec.params.get('port')) || (await getFreePort());

    const [cmd, ...cmdArgs] = resolveBootCommand(image, opts.commands);
    const child: ChildProcess = spawn(cmd, cmdArgs, {
      env: {
        ...buildGuestEnv(),
        ...(opts.env ?? {}),
        PORT: String(port),
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    // A missing binary (ENOENT) emits 'error' instead of exiting; with no
    // listener that is an uncaught exception that takes the host down.
    const spawnFailure = new Promise<never>((_, reject) => {
      child.once('error', (error) => {
        reject(
          new Error(
            `[machinen-plugin] failed to spawn guest process for "${spec.entry}": ${error.message}`,
          ),
        );
      });
    });
    spawnFailure.catch(() => {}); // raced below; never let it go unhandled

    const handle = httpMachineHandle(`http://127.0.0.1:${port}`);
    // HTTP handles always carry these; check once so later uses need no `!`.
    const { health, getState, setState } = handle;
    if (!health || !getState || !setState) {
      throw new Error(
        '[machinen-plugin] processDriver needs a handle with health and state support',
      );
    }
    await Promise.race([waitForManifest(health, child, spec.entry), spawnFailure]);
    if (restoreState !== undefined) {
      try {
        await setState(restoreState);
      } catch (error) {
        child.kill();
        throw error;
      }
    }

    const snapshot = async () => {
      const state = await getState();
      await mkdir(snapshotDir, { recursive: true });
      const bundle: SnapshotBundle = {
        name: spec.remoteName,
        image,
        state,
        createdAt: new Date().toISOString(),
      };
      const snapFile = path.join(snapshotDir, `${spec.remoteName}-${Date.now()}${SNAP_SUFFIX}`);
      await writeFile(snapFile, JSON.stringify(bundle, null, 2));
      return { snapFile, name: spec.remoteName, image };
    };

    return {
      ...handle,
      snapshot,
      dispose: async () => {
        child.kill();
      },
    };
  }

  return {
    async boot(spec) {
      if (spec.kind !== 'image' || !spec.image) {
        throw new Error(
          `[machinen-plugin] processDriver expects a machinen://<image> entry, got "${spec.entry}"`,
        );
      }
      if (spec.image.endsWith(SNAP_SUFFIX)) {
        const bundle = JSON.parse(await readFile(spec.image, 'utf8')) as SnapshotBundle;
        return bootProcess(spec, bundle.image, bundle.state);
      }
      return bootProcess(spec, spec.image);
    },
  };
}

function probePort(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

export async function getFreePort(): Promise<number> {
  let lastError: unknown;
  for (let attempt = 0; attempt < PORT_PROBE_ATTEMPTS; attempt++) {
    const candidate =
      RESERVED_PORT_MIN + Math.floor(Math.random() * (RESERVED_PORT_MAX - RESERVED_PORT_MIN));
    try {
      return await probePort(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  // Fallback to the kernel's choice if the reserved range is unexpectedly
  // saturated or unavailable; preserve the old behavior instead of failing.
  try {
    return await probePort(0);
  } catch (fallbackError) {
    throw new Error(
      `[machinen-plugin] getFreePort: ${PORT_PROBE_ATTEMPTS} reserved-range probes failed ` +
        `(last: ${(lastError as Error)?.message ?? lastError}); listen(0) fallback failed too: ` +
        `${(fallbackError as Error)?.message ?? fallbackError}`,
      { cause: fallbackError },
    );
  }
}

async function waitForManifest(
  health: NonNullable<MachineHandle['health']>,
  child: ChildProcess,
  entry: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`[machinen-plugin] guest process for "${entry}" exited early`);
    }
    try {
      if (await health()) return;
      throw new Error('health probe not ready');
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  child.kill();
  throw new Error(`[machinen-plugin] machine "${entry}" did not become ready: ${lastError}`);
}
