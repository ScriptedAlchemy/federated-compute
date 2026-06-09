import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { processDriver } from '../src/drivers/process.js';
import { parseMachineEntry, type MachineHandle } from '../src/types.js';
import { GuestError } from '../src/errors.js';

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

const APPS = path.resolve(import.meta.dirname, '../../../apps');
const TOKEN = 'conformance-secret';

function runtimeAvailable(cmd: string): boolean {
  return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status !== null;
}

interface GuestTarget {
  label: string;
  image: string;
  expectName: string;
  sampleCall: { module: string; fn: string; args: unknown[]; expect: unknown };
  available: boolean;
}

const targets: GuestTarget[] = [
  {
    label: 'java guest',
    image: path.join(APPS, 'remote-java/Main.java'),
    expectName: 'java_machine',
    sampleCall: { module: './strings', fn: 'upper', args: ['ok'], expect: 'OK' },
    available: runtimeAvailable('java'),
  },
  {
    label: 'python guest',
    image: path.join(APPS, 'remote-python/main.py'),
    expectName: 'python_machine',
    sampleCall: { module: './data', fn: 'sortNumbers', args: [[3, 1, 2]], expect: [1, 2, 3] },
    available: runtimeAvailable('python3'),
  },
];

const disposers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const dispose of disposers) await dispose();
});

const handles = new Map<string, Promise<{ handle: MachineHandle; port: number }>>();
function bootOnce(target: GuestTarget): Promise<{ handle: MachineHandle; port: number }> {
  let booting = handles.get(target.label);
  if (!booting) {
    booting = (async () => {
      const port = await getFreePort();
      const spec = parseMachineEntry(
        'conformance',
        `machinen://${target.image}?port=${port}&token=${TOKEN}`,
      );
      const handle = await processDriver().boot(spec);
      disposers.push(() => handle.dispose?.());
      return { handle, port };
    })();
    handles.set(target.label, booting);
  }
  return booting;
}

for (const target of targets) {
  describe.skipIf(!target.available)(`guest protocol conformance: ${target.label}`, () => {
    test('manifest is protocol v3 with version and typed signatures', { timeout: 30_000 }, async () => {
      const { handle } = await bootOnce(target);
      const manifest = await handle.manifest();

      expect(manifest.name).toBe(target.expectName);
      expect(manifest.protocol).toBe(3);
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(typeof manifest.metaData?.runtime).toBe('string');
      for (const fns of Object.values(manifest.exposes)) {
        for (const sig of Object.values(fns)) {
          expect(Array.isArray(sig.params)).toBe(true);
          expect(typeof sig.returns).toBe('string');
        }
      }
    });

    test('health endpoint responds without auth', { timeout: 30_000 }, async () => {
      const { port } = await bootOnce(target);
      const res = await fetch(`http://127.0.0.1:${port}/mf/health`);
      expect(res.status).toBe(200);
    });

    test('calls round-trip with JSON values', { timeout: 30_000 }, async () => {
      const { handle } = await bootOnce(target);
      const { module, fn, args, expect: expected } = target.sampleCall;
      await expect(handle.call(module, fn, args)).resolves.toEqual(expected);
    });

    test('unknown functions produce a typed error envelope', { timeout: 30_000 }, async () => {
      const { handle } = await bootOnce(target);
      const error = await handle.call('./nope', 'missing', []).catch((e) => e);
      expect(error).toBeInstanceOf(GuestError);
      expect(error.message).toContain('nope');
      expect(typeof error.remoteType).toBe('string');
    });

    test('requests without the bearer token are rejected with 401', { timeout: 30_000 }, async () => {
      const { port } = await bootOnce(target);
      const res = await fetch(`http://127.0.0.1:${port}/mf/manifest`);
      expect(res.status).toBe(401);
    });
  });
}
