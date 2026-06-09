import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { MachineDriver, MachineHandle } from '../types.js';
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

/**
 * Driver that boots the machine guest as a local child process — the stand-in
 * for `@machinen/runtime`'s `boot()` until its source is public. The entry's
 * image path is the guest program: `machinen://./dist/guest.js?port=3001`,
 * `machinen://./Main.java?port=3002`, `machinen://./app.jar?port=3003`, ...
 */
export function processDriver(opts: { commands?: BootCommandMap } = {}): MachineDriver {
  return {
    async boot(spec) {
      if (spec.kind !== 'image' || !spec.image) {
        throw new Error(
          `[machinen-plugin] processDriver expects a machinen://<image> entry, got "${spec.entry}"`,
        );
      }
      // The driver owns transport: explicit port param wins, otherwise a free
      // port is allocated (mirrors Machinen's port-forwarding model).
      const port = Number(spec.params.get('port')) || (await getFreePort());
      const token = spec.params.get('token') ?? undefined;

      const [cmd, ...cmdArgs] = resolveBootCommand(spec.image, opts.commands);
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
      return {
        ...handle,
        dispose: async () => {
          child.kill();
        },
      };
    },
  };
}

function getFreePort(): Promise<number> {
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
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`[machinen-plugin] guest process for "${entry}" exited early`);
    }
    try {
      await handle.manifest();
      return;
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  child.kill();
  throw new Error(`[machinen-plugin] machine "${entry}" did not become ready: ${lastError}`);
}
