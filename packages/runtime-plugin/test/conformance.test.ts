import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { getFreePort, processDriver } from '../src/drivers/process.js';
import { parseMachineEntry, type MachineHandle } from '../src/types.js';
import { GuestError } from '../src/errors.js';

const APPS = path.resolve(import.meta.dirname, '../../../apps');

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
        `machinen://${target.image()}?port=${port}`,
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

    test('health endpoint responds', { timeout: 30_000 }, async () => {
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
      const res = await fetch(`http://127.0.0.1:${port}/mf-types.ts`);
      expect(res.status).toBe(target.types.status);
      if (target.types.status === 200) {
        expect(await res.text()).toContain(target.types.contains);
      }
    });

    test('artifact endpoints follow the capability gate (pull federation)', { timeout: 30_000 }, async () => {
      const { handle, port } = await bootOnce(target);
      const manifest = await handle.manifest();

      const image = manifest.artifacts?.image;
      if (image) {
        // An advertised image must be fetchable and digest-true.
        const res = await fetch(`http://127.0.0.1:${port}${image.href}`);
        expect(res.status).toBe(200);
        const bytes = Buffer.from(await res.arrayBuffer());
        expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(image.digest);
      } else {
        // Unadvertised capability: the endpoint must answer 404/501, never 200.
        const res = await fetch(`http://127.0.0.1:${port}/mf-image`);
        expect([404, 501]).toContain(res.status);
      }

      const snapshot = manifest.artifacts?.snapshot;
      if (snapshot) {
        const res = await fetch(`http://127.0.0.1:${port}${snapshot.href}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { imageDigest?: string; state?: unknown };
        expect(body.imageDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(body).toHaveProperty('state');
      } else {
        const res = await fetch(`http://127.0.0.1:${port}/mf-snapshot`);
        expect([404, 501]).toContain(res.status);
      }
    });

    test('state capture round-trips (snapshot capability)', { timeout: 30_000 }, async () => {
      const { handle } = await bootOnce(target);
      const before = await handle.call('./counter', 'increment', []);
      const state = (await handle.getState!()) as { counter: number };
      expect(state.counter).toBeGreaterThanOrEqual(Number(before));

      await handle.setState!({ counter: 41 });
      await expect(handle.call('./counter', 'increment', [])).resolves.toBe(42);
    });

    const post = async (port: number, path: string, body: string) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });

    test('malformed bodies get the canonical 400 ParseError envelope, no echo, connection live', { timeout: 30_000 }, async () => {
      const { port, handle } = await bootOnce(target);
      const probe = '<script>alert(1)</script>{{{not json';
      for (const endpoint of ['/mf/call', '/mf/state']) {
        const res = await post(port, endpoint, probe);
        expect(res.status).toBe(400);
        const text = await res.text();
        expect(JSON.parse(text)).toEqual({
          ok: false,
          error: { message: 'malformed request body', type: 'ParseError' },
        });
        // The message is constant — the body must never be reflected.
        expect(text).not.toContain('alert');
      }
      // The guest survives: health stays live and a normal call still works.
      const health = await fetch(`http://127.0.0.1:${port}/mf/health`);
      expect(health.status).toBe(200);
      const { module, fn, args, expect: expected } = target.sampleCall;
      await expect(handle.call(module, fn, args)).resolves.toEqual(expected);
    });

    test('non-object JSON bodies are malformed requests too', { timeout: 30_000 }, async () => {
      const { port } = await bootOnce(target);
      for (const body of ['[1,2,3]', '"a string"', '42', 'null']) {
        const res = await post(port, '/mf/call', body);
        expect(res.status).toBe(400);
        const envelope = (await res.json()) as { error: { type: string } };
        expect(envelope.error.type).toBe('ParseError');
      }
    });

    test('oversized bodies get a 413 envelope and the guest stays live', { timeout: 30_000 }, async () => {
      const { port } = await bootOnce(target);
      const oversized = `{"module":"./x","fn":"y","args":["${'x'.repeat(6 * 1024 * 1024)}"]}`;
      const res = await post(port, '/mf/call', oversized);
      expect(res.status).toBe(413);
      const envelope = (await res.json()) as { error: { type: string } };
      expect(envelope.error.type).toBe('PayloadError');

      const health = await fetch(`http://127.0.0.1:${port}/mf/health`);
      expect(health.status).toBe(200);
    });

    if (target.label === 'java guest') {
      test('JSON nested deeper than 256 levels is a 400 parse error, and /mf/health stays live', { timeout: 30_000 }, async () => {
        const { port } = await bootOnce(target);
        const nested = '['.repeat(300) + ']'.repeat(300);
        const res = await post(
          port,
          '/mf/call',
          `{"module":"./strings","fn":"upper","args":${nested}}`,
        );
        expect(res.status).toBe(400);
        const envelope = (await res.json()) as { error: { type: string } };
        expect(envelope.error.type).toBe('ParseError');

        const health = await fetch(`http://127.0.0.1:${port}/mf/health`);
        expect(health.status).toBe(200);
      });
    }
  });
}
