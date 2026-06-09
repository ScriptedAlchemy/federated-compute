import http from 'node:http';
import { afterAll, describe, expect, test } from 'vitest';
import { createInstance } from '@module-federation/runtime';
import { machinenPlugin } from '../src/index.js';
import {
  isTransportFailure,
  MachineAuthError,
  MachineCircuitOpenError,
  MachineRequestError,
  MachineTimeoutError,
  MachineTransportError,
} from '../src/errors.js';
import { createGuestRuntime, serveGuest, type GuestServer } from '../src/guest.js';
import { httpAttachDriver, httpMachineHandle } from '../src/drivers/http.js';
import type { CallOptions, MachineExposeManifest, MachineHandle } from '../src/types.js';

let testId = 500;
function uniqueRemote(entrySuffix = '') {
  testId++;
  return {
    name: `resilience_machine_${testId}`,
    entry: `machinen://images/resilience-${testId}.img${entrySuffix}`,
  };
}

function manifestFor(name: string, exposes?: MachineExposeManifest['exposes']): MachineExposeManifest {
  return {
    name,
    protocol: 3,
    version: '1.0.0',
    exposes: exposes ?? { './svc': { run: { params: [], returns: 'string' } } },
  };
}

function host(plugin: ReturnType<typeof machinenPlugin>, remote: { name: string; entry: string }) {
  return createInstance({ name: `host_${remote.name}`, remotes: [remote], plugins: [plugin] });
}

function connRefused(): Error {
  const error = new Error('connection refused');
  (error as NodeJS.ErrnoException).code = 'ECONNREFUSED';
  return error;
}

interface Deferred {
  promise: Promise<unknown>;
  reject(error: unknown): void;
}

function deferred(): Deferred {
  let reject!: (error: unknown) => void;
  const promise = new Promise((_, rej) => {
    reject = rej;
  });
  promise.catch(() => {}); // observed via the call path; never unhandled here
  return { promise, reject };
}

async function until(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const guestServers: GuestServer[] = [];
const rawServers: http.Server[] = [];
afterAll(async () => {
  await Promise.all(guestServers.map((s) => s.close()));
  for (const s of rawServers) s.close();
});

function listen(server: http.Server): Promise<number> {
  rawServers.push(server);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
  );
}

describe('token leakage (MAJOR-1)', () => {
  test('boot failure error messages never contain the token', async () => {
    // httpAttachDriver rejects image entries; the thrown message interpolates
    // the entry — which must be the redacted form.
    const remote = { name: 'leaky_machine', entry: 'machinen://images/leak.img?token=hush-hush' };
    const plugin = machinenPlugin({ driver: httpAttachDriver() });
    const h = host(plugin, remote);

    const error = (await h.loadRemote('leaky_machine/math').catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/httpAttachDriver expects/);
    expect(error.message).not.toContain('hush-hush');
  });

  test('auth still reaches the guest out-of-band', async () => {
    const guest = createGuestRuntime({
      name: 'auth_guest',
      exposes: { './math': { add: (a: number, b: number) => a + b } },
    });
    const server = await serveGuest(guest, { port: 0, token: 'sesame' });
    guestServers.push(server);

    const remote = {
      name: 'auth_guest',
      entry: `machinen+http://127.0.0.1:${server.port}?token=sesame`,
    };
    const plugin = machinenPlugin({ driver: httpAttachDriver() });
    const h = host(plugin, remote);

    const mod = await h.loadRemote<{ add(a: number, b: number): Promise<number> }>(
      'auth_guest/math',
    );
    await expect(mod!.add(2, 3)).resolves.toBe(5);
  });
});

describe('crash race (MAJOR-2)', () => {
  test('concurrent transport failures reboot once and leak no handles', async () => {
    const remote = uniqueRemote();
    const pending: Deferred[] = [];
    const handles: { disposed: number }[] = [];
    const plugin = machinenPlugin({
      restartOnCrash: true,
      calls: { retries: 0, backoffMs: 1, circuitBreaker: false },
      driver: {
        boot: async () => {
          const tracker = { disposed: 0 };
          handles.push(tracker);
          return {
            manifest: async () => manifestFor(remote.name),
            call: () => {
              const d = deferred();
              pending.push(d);
              return d.promise;
            },
            dispose: async () => {
              tracker.disposed++;
            },
          } satisfies MachineHandle;
        },
      },
    });
    const h = host(plugin, remote);
    const mod = await h.loadRemote<{ run(): Promise<string> }>(`${remote.name}/svc`);

    const callA = mod!.run().catch((e: unknown) => e);
    const callB = mod!.run().catch((e: unknown) => e);
    await until(() => pending.length === 2); // both attempts in flight on boot #1

    // A's transport failure: crash boot #1, reboot, retry on boot #2.
    pending[0].reject(connRefused());
    await until(() => pending.length === 3);

    // B's late failure is for the already-crashed boot #1: it must NOT evict
    // the live boot #2 — its retry reuses it instead of booting a third time.
    pending[1].reject(connRefused());
    await until(() => pending.length === 4);

    pending[2].reject(connRefused());
    pending[3].reject(connRefused());
    await expect(callA).resolves.toBeInstanceOf(Error);
    await expect(callB).resolves.toBeInstanceOf(Error);

    expect(handles.length).toBe(2); // initial boot + exactly one shared reboot
    await plugin.disposeMachines();
    // Crashed handle disposed on the crash path, live handle by disposeMachines.
    expect(handles.every((tracker) => tracker.disposed > 0)).toBe(true);
  });
});

describe('timeout cancellation (MAJOR-3)', () => {
  test('the in-flight call sees an aborted signal when the deadline trips', async () => {
    const remote = uniqueRemote();
    let seen: AbortSignal | undefined;
    const plugin = machinenPlugin({
      calls: { timeoutMs: 30, circuitBreaker: false },
      driver: {
        boot: async () => ({
          manifest: async () => manifestFor(remote.name),
          call: (_m: string, _f: string, _a: unknown[], opts?: CallOptions) => {
            seen = opts?.signal;
            return new Promise(() => {}); // hangs forever
          },
        }),
      },
    });
    const h = host(plugin, remote);
    const mod = await h.loadRemote<{ run(): Promise<string> }>(`${remote.name}/svc`);

    await expect(mod!.run()).rejects.toBeInstanceOf(MachineTimeoutError);
    expect(seen).toBeDefined();
    expect(seen!.aborted).toBe(true);
  });
});

describe('HTTP status classification (MAJOR-4)', () => {
  test('a guest answering 413 is not retried, restarted, or crashed', async () => {
    const name = 'oversize_machine';
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/mf-manifest.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(manifestFor(name)));
        return;
      }
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { message: 'payload too large' } }));
    });
    const port = await listen(server);

    let boots = 0;
    const base = httpAttachDriver();
    const plugin = machinenPlugin({
      restartOnCrash: true,
      calls: { retries: 2, backoffMs: 1, circuitBreaker: false },
      driver: {
        boot: (spec) => {
          boots++;
          return base.boot(spec);
        },
      },
    });
    const crashes: unknown[] = [];
    plugin.machineHooks.onMachineCrash.on(({ error }) => crashes.push(error));

    const remote = { name, entry: `machinen+http://127.0.0.1:${port}` };
    const h = host(plugin, remote);
    const mod = await h.loadRemote<{ run(): Promise<string> }>(`${name}/svc`);

    const error = (await mod!.run().catch((e: unknown) => e)) as MachineRequestError;
    expect(error).toBeInstanceOf(MachineRequestError);
    expect(error.status).toBe(413);
    expect(isTransportFailure(error)).toBe(false);
    expect(boots).toBe(1); // no restart
    expect(crashes).toEqual([]); // no crash bookkeeping
  });

  test('401 surfaces as MachineAuthError, not a transport failure', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { message: 'unauthorized' } }));
    });
    const port = await listen(server);
    const handle = httpMachineHandle(`http://127.0.0.1:${port}`);

    const manifestError = await handle.manifest().catch((e: unknown) => e);
    expect(manifestError).toBeInstanceOf(MachineAuthError);
    const callError = await handle.call('./svc', 'run', []).catch((e: unknown) => e);
    expect(callError).toBeInstanceOf(MachineAuthError);
    expect(isTransportFailure(callError)).toBe(false);
  });

  test('5xx still classifies as a transport failure', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(502);
      res.end();
    });
    const port = await listen(server);
    const handle = httpMachineHandle(`http://127.0.0.1:${port}`);

    const error = await handle.call('./svc', 'run', []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MachineTransportError);
    expect(isTransportFailure(error)).toBe(true);
  });
});

describe('stream policy (MINOR)', () => {
  test('streams are gated by the circuit breaker and count transport failures', async () => {
    const remote = uniqueRemote();
    let streamStarts = 0;
    const plugin = machinenPlugin({
      calls: { circuitBreaker: { threshold: 1, resetMs: 60_000 } },
      driver: {
        boot: async () => ({
          manifest: async () =>
            manifestFor(remote.name, {
              './svc': { tail: { params: [], returns: 'string', stream: true } },
            }),
          call: async () => 'unused',
          // eslint-disable-next-line require-yield
          callStream: async function* (): AsyncIterable<unknown> {
            streamStarts++;
            throw new MachineTransportError('connection cut mid-stream');
          },
        }),
      },
    });
    const h = host(plugin, remote);
    const mod = await h.loadRemote<{ tail(): AsyncIterable<string> }>(`${remote.name}/svc`);

    const consume = async () => {
      for await (const _chunk of mod!.tail()) {
        // drain
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(MachineTransportError);
    // Threshold reached: the next stream fails fast without hitting the machine.
    await expect(consume()).rejects.toBeInstanceOf(MachineCircuitOpenError);
    expect(streamStarts).toBe(1);
  });
});

describe('manifest hygiene (MINOR)', () => {
  test('post-restart module loads build from the current manifest, not a stale capture', async () => {
    const remote = uniqueRemote();
    let boots = 0;
    const plugin = machinenPlugin({
      restartOnCrash: false,
      calls: { retries: 0, circuitBreaker: false },
      driver: {
        boot: async () => {
          boots++;
          const exposes =
            boots === 1
              ? { './svc': { run: { params: [], returns: 'string' } } }
              : { './late': { arrive: { params: [], returns: 'string' } } };
          return {
            manifest: async () => manifestFor(remote.name, exposes),
            call: async (modulePath: string) => {
              if (boots === 1) throw connRefused();
              return `from ${modulePath}`;
            },
          };
        },
      },
    });
    const h = host(plugin, remote);

    const mod = await h.loadRemote<{ run(): Promise<string> }>(`${remote.name}/svc`);
    await expect(mod!.run()).rejects.toThrow(/connection refused/); // crashes machine #1

    // The machine restarted with a different manifest; the container must
    // rebuild from it instead of serving boot #1's expose map.
    const late = await h.loadRemote<{ arrive(): Promise<string> }>(`${remote.name}/late`);
    await expect(late!.arrive()).resolves.toBe('from ./late');
    expect(boots).toBe(2);
  });

  test('rejects manifests that speak a different guest protocol', async () => {
    const remote = uniqueRemote();
    const plugin = machinenPlugin({
      driver: {
        boot: async () => ({
          manifest: async () =>
            ({ ...manifestFor(remote.name), protocol: 2 }) as unknown as MachineExposeManifest,
          call: async () => 'ok',
        }),
      },
    });
    const h = host(plugin, remote);
    await expect(h.loadRemote(`${remote.name}/svc`)).rejects.toThrow(
      /guest protocol 2, expected 3/,
    );
  });

  test('rejects manifests without an exposes map', async () => {
    const remote = uniqueRemote();
    const plugin = machinenPlugin({
      driver: {
        boot: async () => ({
          manifest: async () =>
            ({ name: remote.name, protocol: 3, version: '1.0.0' }) as MachineExposeManifest,
          call: async () => 'ok',
        }),
      },
    });
    const h = host(plugin, remote);
    await expect(h.loadRemote(`${remote.name}/svc`)).rejects.toThrow(/no "exposes" map/);
  });
});

describe('disposeMachines (MINOR)', () => {
  test('one throwing dispose does not abort the rest, and state is cleared', async () => {
    const a = uniqueRemote();
    const b = uniqueRemote();
    let bDisposed = false;
    const handleFor = (name: string, dispose: () => Promise<void>): MachineHandle => ({
      manifest: async () => manifestFor(name),
      call: async () => 'ok',
      dispose,
    });
    const plugin = machinenPlugin({
      driver: {
        boot: async (spec) =>
          spec.remoteName === a.name
            ? handleFor(a.name, async () => {
                throw new Error('dispose exploded');
              })
            : handleFor(b.name, async () => {
                bDisposed = true;
              }),
      },
    });
    const h = createInstance({
      name: `host_${a.name}`,
      remotes: [a, b],
      plugins: [plugin],
    });
    const modA = await h.loadRemote<{ run(): Promise<string> }>(`${a.name}/svc`);
    await modA!.run();
    await h.loadRemote(`${b.name}/svc`);

    await expect(plugin.disposeMachines()).resolves.toBeUndefined();
    expect(bDisposed).toBe(true);
    expect(plugin.metrics()).toEqual({}); // recorders cleared with the machines
  });
});

describe('token redaction across the failure surface (MAJOR-1, ported)', () => {
  const TOKEN = 'super-secret-token-do-not-leak';

  test('transport failures and crash hooks never carry the token', async () => {
    // Nothing listens on this port: every request is a transport failure.
    const plugin = machinenPlugin({
      driver: httpAttachDriver(),
      restartOnCrash: false,
      bootTimeoutMs: 2_000,
      calls: { retries: 0, circuitBreaker: false },
    });
    const crashEntries: string[] = [];
    plugin.machineHooks.onMachineCrash.on(({ spec }) => crashEntries.push(spec.entry));
    const bootEntries: string[] = [];
    plugin.machineHooks.beforeMachineBoot.on(({ spec }) =>
      bootEntries.push(`${spec.entry} ${spec.params.toString()}`),
    );
    const remote = { name: 'dead_machine', entry: `machinen+http://127.0.0.1:1?token=${TOKEN}` };
    const h = host(plugin, remote);

    const error = (await h.loadRemote(`${remote.name}/svc`).catch((e: unknown) => e)) as Error;
    expect(error).toBeTruthy();
    expect(`${error.name} ${error.message} ${error.stack ?? ''}`).not.toContain(TOKEN);
    expect(bootEntries.length).toBeGreaterThan(0);
    for (const entry of [...bootEntries, ...crashEntries]) {
      expect(entry).not.toContain(TOKEN);
    }
  });

  test('reboots after a crash keep authenticating with the out-of-band token', async () => {
    const guest = createGuestRuntime({
      name: 'reboot_secured',
      exposes: { './math': { add: (a: number, b: number) => a + b } },
    });
    const server = await serveGuest(guest, { port: 0, token: TOKEN });
    guestServers.push(server);

    let boots = 0;
    const base = httpAttachDriver();
    const plugin = machinenPlugin({
      restartOnCrash: true,
      calls: { retries: 0, backoffMs: 1, circuitBreaker: false },
      driver: {
        boot: async (spec) => {
          boots++;
          const handle = await base.boot(spec);
          if (boots === 1) {
            // First generation dies on its first call.
            return { ...handle, call: async () => Promise.reject(connRefused()) };
          }
          return handle;
        },
      },
    });
    const remote = {
      name: 'reboot_secured_machine',
      entry: `machinen+http://127.0.0.1:${server.port}?token=${TOKEN}`,
    };
    const h = host(plugin, remote);
    const mod = await h.loadRemote<{ add(a: number, b: number): Promise<number> }>(
      `${remote.name}/math`,
    );

    // Crash -> reboot -> the second generation's real HTTP call must still
    // carry the token even though the cached (redacted) spec.entry has none.
    await expect(mod!.add(3, 4)).resolves.toBe(7);
    expect(boots).toBe(2);
  });
});

describe('crash bookkeeping (MAJOR-2, ported)', () => {
  test('a crashed handle is disposed even without restartOnCrash', async () => {
    const remote = uniqueRemote();
    let disposed = 0;
    const plugin = machinenPlugin({
      restartOnCrash: false,
      calls: { retries: 0, circuitBreaker: false },
      driver: {
        boot: async () => ({
          manifest: async () => manifestFor(remote.name),
          call: async () => Promise.reject(connRefused()),
          dispose: async () => {
            disposed++;
          },
        }),
      },
    });
    const h = host(plugin, remote);
    const mod = await h.loadRemote<{ run(): Promise<string> }>(`${remote.name}/svc`);

    await expect(mod!.run()).rejects.toThrow(/connection refused/);
    expect(disposed).toBe(1);
  });

  test('a boot that completes after the boot timeout is disposed, not leaked', async () => {
    const remote = uniqueRemote();
    let disposed = 0;
    const plugin = machinenPlugin({
      bootTimeoutMs: 25,
      driver: {
        boot: async (): Promise<MachineHandle> => {
          await new Promise((resolve) => setTimeout(resolve, 80));
          return {
            manifest: async () => manifestFor(remote.name),
            call: async () => 'late',
            dispose: async () => {
              disposed++;
            },
          };
        },
      },
    });
    const h = host(plugin, remote);

    await expect(h.loadRemote(`${remote.name}/svc`)).rejects.toThrow(/timed out/);
    await until(() => disposed === 1);
  });

  test('a boot that fails after creating a handle (version mismatch) disposes it', async () => {
    const remote = uniqueRemote('?version=^9.0.0');
    let disposed = 0;
    const plugin = machinenPlugin({
      driver: {
        boot: async () => ({
          manifest: async () => ({ ...manifestFor(remote.name), version: '2.0.0' }),
          call: async () => 'never',
          dispose: async () => {
            disposed++;
          },
        }),
      },
    });
    const h = host(plugin, remote);

    await expect(h.loadRemote(`${remote.name}/svc`)).rejects.toThrow(/version/);
    expect(disposed).toBe(1);
  });
});

describe('cancellation across retries (MAJOR-3, ported)', () => {
  test('every retry attempt gets its own fresh abort signal', async () => {
    const remote = uniqueRemote();
    const signals: AbortSignal[] = [];
    const plugin = machinenPlugin({
      restartOnCrash: false,
      calls: { timeoutMs: 20, retries: 1, backoffMs: 1, circuitBreaker: false },
      driver: {
        boot: async () => ({
          manifest: async () => manifestFor(remote.name),
          call: (_m: string, _f: string, _a: unknown[], opts?: CallOptions) => {
            if (opts?.signal) {
              expect(opts.signal.aborted).toBe(false); // fresh per attempt
              signals.push(opts.signal);
            }
            return new Promise<never>(() => {}); // hangs forever
          },
        }),
      },
    });
    const h = host(plugin, remote);
    const mod = await h.loadRemote<{ run(): Promise<string> }>(`${remote.name}/svc`);

    await expect(mod!.run()).rejects.toBeInstanceOf(MachineTimeoutError);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});

describe('status classification edge cases (MAJOR-4, ported)', () => {
  test('a plain 404 from the guest is a MachineRequestError carrying the status', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const port = await listen(server);
    const handle = httpMachineHandle(`http://127.0.0.1:${port}`);

    const error = (await handle
      .call('./svc', 'run', [])
      .catch((e: unknown) => e)) as MachineRequestError;
    expect(error).toBeInstanceOf(MachineRequestError);
    expect(error.status).toBe(404);
    expect(isTransportFailure(error)).toBe(false);
  });

  test('after a 413 the machine stays booted and the next call succeeds', async () => {
    const guest = createGuestRuntime({
      name: 'big_guest',
      exposes: { './echo': { size: (s: string) => s.length } },
    });
    const server = await serveGuest(guest, { port: 0 });
    guestServers.push(server);

    let boots = 0;
    const base = httpAttachDriver();
    const plugin = machinenPlugin({
      restartOnCrash: true,
      calls: { retries: 2, backoffMs: 1, circuitBreaker: false },
      driver: {
        boot: (spec) => {
          boots++;
          return base.boot(spec);
        },
      },
    });
    const crashes: unknown[] = [];
    plugin.machineHooks.onMachineCrash.on(() => crashes.push(1));

    const remote = { name: 'big_guest_e2e', entry: `machinen+http://127.0.0.1:${server.port}` };
    const h = host(plugin, remote);
    const mod = await h.loadRemote<{ size(s: string): Promise<number> }>(`${remote.name}/echo`);

    const error = (await mod!
      .size('x'.repeat(6 * 1024 * 1024))
      .catch((e: unknown) => e)) as MachineRequestError;
    expect(error).toBeInstanceOf(MachineRequestError);
    expect(error.status).toBe(413);

    const metrics = plugin.metrics()[remote.name];
    expect(metrics.retries).toBe(0);
    expect(metrics.crashes).toBe(0);
    expect(crashes).toHaveLength(0);

    // The machine is alive and untouched: a normal call still works.
    await expect(mod!.size('abc')).resolves.toBe(3);
    expect(boots).toBe(1);
  });
});

describe('restartOnCrash × circuit breaker (ported)', () => {
  test('persistent failures open the circuit across crash/reboot cycles', async () => {
    const remote = uniqueRemote();
    let boots = 0;
    const plugin = machinenPlugin({
      restartOnCrash: true,
      calls: { retries: 0, backoffMs: 1, circuitBreaker: { threshold: 2, resetMs: 60_000 } },
      driver: {
        boot: async () => {
          boots++;
          return {
            manifest: async () => manifestFor(remote.name),
            call: async () => Promise.reject(connRefused()),
          };
        },
      },
    });
    const opened: string[] = [];
    plugin.machineHooks.onCircuitOpen.on(({ spec }) => opened.push(spec.remoteName));

    const h = host(plugin, remote);
    const mod = await h.loadRemote<{ run(): Promise<string> }>(`${remote.name}/svc`);

    // Each failed call counts toward the breaker and reboots the machine.
    await expect(mod!.run()).rejects.toThrow(/connection refused/);
    expect(boots).toBe(2);
    await expect(mod!.run()).rejects.toThrow(/connection refused/);
    expect(opened).toEqual([remote.name]); // threshold reached

    // Circuit is open: fail fast, no further boots.
    const bootsBefore = boots;
    await expect(mod!.run()).rejects.toBeInstanceOf(MachineCircuitOpenError);
    expect(boots).toBe(bootsBefore);

    const metrics = plugin.metrics()[remote.name];
    expect(metrics.crashes).toBeGreaterThanOrEqual(2);
    expect(metrics.circuitOpens).toBe(1);
  });
});
