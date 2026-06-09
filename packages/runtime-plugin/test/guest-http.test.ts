import { afterAll, describe, expect, test } from 'vitest';
import { createGuestRuntime, serveGuest, type GuestServer } from '../src/guest.js';
import { httpMachineHandle } from '../src/drivers/http.js';
import { GuestError } from '../src/errors.js';

const servers: GuestServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

async function startGuest(opts: { token?: string } = {}) {
  const guest = createGuestRuntime({
    name: 'http_guest',
    exposes: {
      './math': {
        add: {
          handler: (a: number, b: number) => a + b,
          params: [
            { name: 'a', type: 'number' },
            { name: 'b', type: 'number' },
          ],
          returns: 'number',
        },
        boom: () => {
          throw new TypeError('guest exploded');
        },
        countdown: {
          handler: async function* (from: number) {
            for (let i = from; i >= 0; i--) yield i;
          },
          params: [{ name: 'from', type: 'number' }],
          returns: 'number',
          stream: true,
        },
      },
    },
  });
  const server = await serveGuest(guest, { port: 0, token: opts.token });
  servers.push(server);
  return server;
}

describe('guest over HTTP', () => {
  test('manifest is protocol v3 with version, metaData, and signatures', async () => {
    const server = await startGuest();
    const handle = httpMachineHandle(`http://127.0.0.1:${server.port}`);
    const manifest = await handle.manifest();

    expect(manifest.protocol).toBe(3);
    expect(manifest.version).toBe('0.0.0');
    expect(manifest.metaData?.runtime).toContain('node');
    expect(manifest.metaData?.features).toContain('stream');
    expect(manifest.exposes['./math'].add).toEqual({
      params: [
        { name: 'a', type: 'number' },
        { name: 'b', type: 'number' },
      ],
      returns: 'number',
    });
    // Plain functions get default signatures.
    expect(manifest.exposes['./math'].boom.returns).toBe('unknown');
    expect(manifest.exposes['./math'].countdown.stream).toBe(true);
  });

  test('calls round-trip and guest errors keep their type', async () => {
    const server = await startGuest();
    const handle = httpMachineHandle(`http://127.0.0.1:${server.port}`);

    await expect(handle.call('./math', 'add', [2, 3])).resolves.toBe(5);

    const error = await handle.call('./math', 'boom', []).catch((e) => e);
    expect(error).toBeInstanceOf(GuestError);
    expect(error.message).toBe('guest exploded');
    expect(error.remoteType).toBe('TypeError');
  });

  test('streams results as an async iterable', async () => {
    const server = await startGuest();
    const handle = httpMachineHandle(`http://127.0.0.1:${server.port}`);

    const received: number[] = [];
    for await (const chunk of handle.callStream!('./math', 'countdown', [3])) {
      received.push(chunk as number);
    }
    expect(received).toEqual([3, 2, 1, 0]);
  });

  test('long streams survive socket backpressure: every chunk arrives, in order', async () => {
    const COUNT = 5000;
    // ~1KB per chunk forces res.write() to return false long before the
    // stream ends, exercising the 'drain' wait in the NDJSON loop.
    const guest = createGuestRuntime({
      name: 'flood_guest',
      exposes: {
        './flood': {
          burst: {
            handler: async function* (n: number) {
              for (let i = 0; i < n; i++) yield `${i}:${'x'.repeat(1024)}`;
            },
            params: [{ name: 'n', type: 'number' }],
            returns: 'string',
            stream: true,
          },
        },
      },
    });
    const server = await serveGuest(guest, { port: 0 });
    servers.push(server);
    const handle = httpMachineHandle(`http://127.0.0.1:${server.port}`);

    let next = 0;
    for await (const chunk of handle.callStream!('./flood', 'burst', [COUNT])) {
      expect((chunk as string).split(':')[0]).toBe(String(next));
      next++;
    }
    expect(next).toBe(COUNT);
  });

  test('rejects requests without the right bearer token', async () => {
    const server = await startGuest({ token: 'secret' });

    const unauthorized = httpMachineHandle(`http://127.0.0.1:${server.port}`);
    await expect(unauthorized.manifest()).rejects.toThrow(/401/);

    const authorized = httpMachineHandle(`http://127.0.0.1:${server.port}`, { token: 'secret' });
    await expect(authorized.call('./math', 'add', [1, 1])).resolves.toBe(2);
  });

  test('health endpoint responds without auth (liveness probes)', async () => {
    const server = await startGuest({ token: 'secret' });
    const res = await fetch(`http://127.0.0.1:${server.port}/mf/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  test('guest serves its own generated bindings at /mf-types.ts (the @mf-types analog)', async () => {
    const server = await startGuest();
    const res = await fetch(`http://127.0.0.1:${server.port}/mf-types.ts`);
    expect(res.status).toBe(200);
    const source = await res.text();
    expect(source).toContain('export interface HttpGuestMath {');
    expect(source).toContain('add(a: number, b: number): Promise<number>;');
    expect(source).toContain("machineModule<HttpGuestMath>('http_guest', './math'");
  });
});

describe('guest state capture (snapshot simulation)', () => {
  async function startStatefulGuest() {
    let counter = 0;
    const guest = createGuestRuntime({
      name: 'stateful_guest',
      exposes: {
        './counter': {
          increment: () => ++counter,
          current: () => counter,
        },
      },
      state: {
        dehydrate: () => ({ counter }),
        rehydrate: (state) => {
          counter = (state as { counter: number }).counter;
        },
      },
    });
    const server = await serveGuest(guest, { port: 0 });
    servers.push(server);
    return server;
  }

  test('manifest advertises the state feature', async () => {
    const server = await startStatefulGuest();
    const handle = httpMachineHandle(`http://127.0.0.1:${server.port}`);
    const manifest = await handle.manifest();
    expect(manifest.metaData?.features).toContain('state');
  });

  test('state round-trips: dehydrate on one guest, rehydrate on another', async () => {
    const a = await startStatefulGuest();
    const handleA = httpMachineHandle(`http://127.0.0.1:${a.port}`);
    await handleA.call('./counter', 'increment', []);
    await handleA.call('./counter', 'increment', []);

    const state = await handleA.getState!();
    expect(state).toEqual({ counter: 2 });

    const b = await startStatefulGuest();
    const handleB = httpMachineHandle(`http://127.0.0.1:${b.port}`);
    await handleB.setState!(state);
    await expect(handleB.call('./counter', 'current', [])).resolves.toBe(2);
    // The donor keeps running independently (fork semantics).
    await expect(handleA.call('./counter', 'increment', [])).resolves.toBe(3);
  });

  test('guests without state support reject state requests', async () => {
    const server = await startGuest();
    const handle = httpMachineHandle(`http://127.0.0.1:${server.port}`);
    await expect(handle.getState!()).rejects.toThrow(/state/i);
  });
});

describe('guest runtime naming validation', () => {
  test('throws for an expose path that is not a JS identifier', () => {
    expect(() =>
      createGuestRuntime({
        name: 'bad_guest',
        exposes: { './word-count': { count: () => 0 } },
      }),
    ).toThrow(/word-count.*'\.\/'.*JS identifier/s);
  });

  test('throws for an expose path missing the "./" prefix', () => {
    expect(() =>
      createGuestRuntime({
        name: 'bad_guest',
        exposes: { math: { add: () => 0 } },
      }),
    ).toThrow(/"math".*'\.\/'/s);
  });

  test('throws for a function name that is not a JS identifier', () => {
    expect(() =>
      createGuestRuntime({
        name: 'bad_guest',
        exposes: { './math': { 'do-thing': () => 0 } },
      }),
    ).toThrow(/do-thing.*JS identifier/s);
  });

  test('accepts valid expose paths and function names', () => {
    const guest = createGuestRuntime({
      name: 'good_guest',
      exposes: {
        './math': { add: (a: number, b: number) => a + b },
        './_private': { $compute: () => 1 },
      },
    });
    expect(Object.keys(guest.manifest().exposes)).toEqual(['./math', './_private']);
  });
});
