import http from 'node:http';
import { afterAll, describe, expect, test } from 'vitest';
import { createGuestRuntime, serveGuest, type GuestServer, type ServeGuestOptions } from '../src/guest.js';
import { httpMachineHandle } from '../src/drivers/http.js';
import {
  GuestError,
  isTransportFailure,
  MachineAuthError,
  MachineRequestError,
  MachineTransportError,
} from '../src/errors.js';

const servers: GuestServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

async function startGuest(opts: Partial<ServeGuestOptions> = {}) {
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
  const server = await serveGuest(guest, { ...opts, port: 0 });
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
    const error = await unauthorized.manifest().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MachineAuthError);
    expect((error as Error).message).toMatch(/401/);
    expect(isTransportFailure(error)).toBe(false); // never retried or restarted

    const authorized = httpMachineHandle(`http://127.0.0.1:${server.port}`, { token: 'secret' });
    await expect(authorized.call('./math', 'add', [1, 1])).resolves.toBe(2);
  });

  test('a guest answering 413 surfaces a non-retriable request error', async () => {
    const server = await startGuest();
    const handle = httpMachineHandle(`http://127.0.0.1:${server.port}`);

    // Push past the guest's 5 MB body cap so it deliberately answers 413.
    const oversized = 'x'.repeat(6 * 1024 * 1024);
    const error = (await handle
      .call('./math', 'add', [oversized, 1])
      .catch((e: unknown) => e)) as MachineRequestError;
    expect(error).toBeInstanceOf(MachineRequestError);
    expect(error.status).toBe(413);
    expect(isTransportFailure(error)).toBe(false);
  });

  test('a stream that ends without the done marker is a transport failure', async () => {
    // A server that drops the connection mid-stream, before {"done": true}.
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write('{"chunk":1}\n{"chunk":2}\n');
      res.end(); // no done marker
    });
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
    );
    servers.push({ port, close: () => new Promise((r) => server.close(() => r())) });

    const handle = httpMachineHandle(`http://127.0.0.1:${port}`);
    const consume = async () => {
      const received: unknown[] = [];
      for await (const chunk of handle.callStream!('./math', 'countdown', [2])) {
        received.push(chunk);
      }
      return received;
    };
    const error = await consume().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MachineTransportError);
    expect((error as Error).message).toMatch(/done marker/);
  });

  test('guest stacks stay private unless exposeStacks is opted into', async () => {
    const closed = await startGuest();
    const closedHandle = httpMachineHandle(`http://127.0.0.1:${closed.port}`);
    const hidden = (await closedHandle.call('./math', 'boom', []).catch((e: unknown) => e)) as GuestError;
    expect(hidden).toBeInstanceOf(GuestError);
    expect(hidden.remoteStack).toBeUndefined();

    const open = await startGuest({ exposeStacks: true });
    const openHandle = httpMachineHandle(`http://127.0.0.1:${open.port}`);
    const shown = (await openHandle.call('./math', 'boom', []).catch((e: unknown) => e)) as GuestError;
    expect(shown).toBeInstanceOf(GuestError);
    expect(shown.remoteStack).toContain('TypeError: guest exploded');
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

  test('throws for an expose path that is a JS reserved word', () => {
    expect(() =>
      createGuestRuntime({
        name: 'bad_guest',
        exposes: { './delete': { it: () => 0 } },
      }),
    ).toThrow(/non-reserved JS identifier/);
  });

  test('throws for a function name that is a JS reserved word', () => {
    expect(() =>
      createGuestRuntime({
        name: 'bad_guest',
        exposes: { './math': { class: () => 0 } },
      }),
    ).toThrow(/"class".*non-reserved/s);
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
