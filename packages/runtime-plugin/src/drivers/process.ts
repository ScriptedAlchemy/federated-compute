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
}

/**
 * Driver that boots the machine guest as a local child process — the stand-in
 * for `@machinen/runtime`'s `boot()` until its source is public. The entry's
 * image path is the guest program: `machinen://./dist/guest.js?port=3001`,
 * `machinen://./Main.java?port=3002`, `machinen://./app.jar?port=3003`, ...
 *
 * Boot once, run everywhere: `handle.snapshot()` freezes the machine's warm
 * state into a `.snap.json` bundle (which, like Machinen snapshot bundles,
 * remembers the image it was booted from). Booting an entry whose image is a
 * `.snap.json` RESTORES: the image boots and the saved state is injected, so
 * the machine resumes where it left off instead of starting over.
 */
export function processDriver(opts: ProcessDriverOptions = {}): MachineDriver {
  const snapshotDir = opts.snapshotDir ?? path.join('.machinen', 'snapshots');

  async function bootProcess(spec: MachineSpec, image: string, restoreState?: unknown) {
    const port = Number(spec.params.get('port')) || (await getFreePort());
    const token = spec.params.get('token') ?? undefined;

    const [cmd, ...cmdArgs] = resolveBootCommand(image, opts.commands);
    const child: ChildProcess = spawn(cmd, cmdArgs, {
      env: {
        ...process.env,
        PORT: String(port),
        ...(token ? { MACHINEN_TOKEN: token } : {}),
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const handle = httpMachineHandle(`http://127.0.0.1:${port}`, { token });
    await waitForManifest(handle, child, spec.entry);
    if (restoreState !== undefined) {
      await handle.setState!(restoreState);
    }

    const snapshot = async () => {
      const state = await handle.getState!();
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

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForManifest(
  handle: MachineHandle,
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
      if (await handle.health!()) return;
      throw new Error('health probe not ready');
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  child.kill();
  throw new Error(`[machinen-plugin] machine "${entry}" did not become ready: ${lastError}`);
}
