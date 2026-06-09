import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { getFreePort, processDriver } from '../src/drivers/process.js';
import { parseMachineEntry, type MachineHandle } from '../src/types.js';
import { GuestError } from '../src/errors.js';

const APPS = path.resolve(import.meta.dirname, '../../../apps');
const TOKEN = 'conformance-secret';

function runtimeAvailable(cmd: string): boolean {
  return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status !== null;
}

/**
 * The Java machine's image is its build artifact; build it via the machine's
 * own build script, which also publishes the static dist/mf-types.ts artifact
 * (building the plugin's bindgen CLI first when its dist is missing).
 */
function ensureJavaJar(): string {
  const jar = path.join(APPS, 'remote-java/dist/java-machine.jar');
  const types = path.join(APPS, 'remote-java/dist/mf-types.ts');
  if (!existsSync(jar) || !existsSync(types)) {
    const result = spawnSync('node', ['build.mjs'], {
      cwd: path.join(APPS, 'remote-java'),
      stdio: 'inherit',
    });
    if (result.status !== 0) throw new Error('remote-java build failed');
  }
  // The booted guest inherits this env and serves the artifact from it.
  process.env.MACHINEN_TYPES_FILE = types;
  return jar;
}

interface GuestTarget {
  label: string;
  image: () => string;
  expectName: string;
  sampleCall: { module: string; fn: string; args: unknown[]; expect: unknown };
  /** /mf-types.ts is a static artifact: published by the build, or 404. */
  types: { status: 200; contains: string } | { status: 404 };
  available: boolean;
}

const targets: GuestTarget[] = [
  {
    label: 'java guest',
    image: ensureJavaJar,
    expectName: 'java_machine',
    sampleCall: { module: './strings', fn: 'upper', args: ['ok'], expect: 'OK' },
    // Its build publishes dist/mf-types.ts (see ensureJavaJar).
    types: { status: 200, contains: 'JavaMachine' },
    available: runtimeAvailable('java'),
  },
  {
    label: 'python guest',
    image: () => path.join(APPS, 'remote-python/main.py'),
    expectName: 'python_machine',
    sampleCall: { module: './data', fn: 'sortNumbers', args: [[3, 1, 2]], expect: [1, 2, 3] },
    // No static artifact is committed — the endpoint is optional, and 404
    // means consumers render bindings from the manifest instead.
    types: { status: 404 },
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
        `machinen://${target.image()}?port=${port}&token=${TOKEN}`,
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

    test('/mf-types.ts follows the static-artifact pattern', { timeout: 30_000 }, async () => {
      const { port } = await bootOnce(target);
      const res = await fetch(`http://127.0.0.1:${port}/mf-types.ts`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(target.types.status);
      if (target.types.status === 200) {
        expect(await res.text()).toContain(target.types.contains);
      }
    });

    test('requests without the bearer token are rejected with 401', { timeout: 30_000 }, async () => {
      const { port } = await bootOnce(target);
      const manifest = await fetch(`http://127.0.0.1:${port}/mf-manifest.json`);
      expect(manifest.status).toBe(401);
      const types = await fetch(`http://127.0.0.1:${port}/mf-types.ts`);
      expect(types.status).toBe(401);
    });

    test('state capture round-trips (snapshot capability)', { timeout: 30_000 }, async () => {
      const { handle } = await bootOnce(target);
      const before = await handle.call('./counter', 'increment', []);
      const state = (await handle.getState!()) as { counter: number };
      expect(state.counter).toBeGreaterThanOrEqual(Number(before));

      await handle.setState!({ counter: 41 });
      await expect(handle.call('./counter', 'increment', [])).resolves.toBe(42);
    });
  });
}
