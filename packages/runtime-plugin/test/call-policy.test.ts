import { describe, expect, test } from 'vitest';
import { createInstance } from '@module-federation/runtime';
import { machinenPlugin } from '../src/index.js';
import { MachineCircuitOpenError, MachineTimeoutError } from '../src/errors.js';
import type { MachineExposeManifest, MachineHandle } from '../src/types.js';

let testId = 100;
function uniqueRemote() {
  testId++;
  return {
    name: `policy_machine_${testId}`,
    entry: `machinen://images/policy-${testId}.tar.gz`,
  };
}

function manifestFor(name: string): MachineExposeManifest {
  return {
    name,
    protocol: 3,
    version: '1.0.0',
    exposes: { './svc': { run: { params: [], returns: 'string' } } },
  };
}

function fakeHandle(
  name: string,
  call: (args: unknown[]) => Promise<unknown>,
): MachineHandle {
  return { manifest: async () => manifestFor(name), call: async (_m, _f, args) => call(args) };
}

function host(plugin: ReturnType<typeof machinenPlugin>, remote: { name: string; entry: string }) {
  return createInstance({ name: `host_${remote.name}`, remotes: [remote], plugins: [plugin] });
}

describe('call policy', () => {
  test('calls that exceed timeoutMs fail with MachineTimeoutError', async () => {
    const remote = uniqueRemote();
    const plugin = machinenPlugin({
      calls: { timeoutMs: 50, circuitBreaker: false },
      driver: {
        boot: async () =>
          fakeHandle(remote.name, () => new Promise((r) => setTimeout(() => r('late'), 1_000))),
      },
    });
    const h = host(plugin, remote);
    const mod = await h.loadRemote<{ run(): Promise<string> }>(`${remote.name}/svc`);

    await expect(mod!.run()).rejects.toBeInstanceOf(MachineTimeoutError);
  });

  test('transport failures are retried with backoff up to `retries` times', async () => {
    const remote = uniqueRemote();
    let attempts = 0;
    const plugin = machinenPlugin({
      calls: { retries: 2, backoffMs: 1, circuitBreaker: false },
      driver: {
        boot: async () =>
          fakeHandle(remote.name, async () => {
            attempts++;
            if (attempts < 3) {
              const err = new Error('flaky network');
              (err as NodeJS.ErrnoException).code = 'ECONNRESET';
              throw err;
            }
            return 'recovered';
          }),
      },
    });
    const h = host(plugin, remote);
    const mod = await h.loadRemote<{ run(): Promise<string> }>(`${remote.name}/svc`);

    await expect(mod!.run()).resolves.toBe('recovered');
    expect(attempts).toBe(3);
  });

  test('guest errors are never retried', async () => {
    const remote = uniqueRemote();
    let attempts = 0;
    const plugin = machinenPlugin({
      calls: { retries: 3, backoffMs: 1, circuitBreaker: false },
      driver: {
        boot: async () =>
          fakeHandle(remote.name, async () => {
            attempts++;
            throw Object.assign(new Error('bad input'), { name: 'GuestError' });
          }),
      },
    });
    const h = host(plugin, remote);
    const mod = await h.loadRemote<{ run(): Promise<string> }>(`${remote.name}/svc`);

    await expect(mod!.run()).rejects.toThrow('bad input');
    expect(attempts).toBe(1);
  });

  test('circuit opens after consecutive transport failures and fails fast', async () => {
    const remote = uniqueRemote();
    let attempts = 0;
    const plugin = machinenPlugin({
      calls: { retries: 0, circuitBreaker: { threshold: 2, resetMs: 60_000 } },
      driver: {
        boot: async () =>
          fakeHandle(remote.name, async () => {
            attempts++;
            const err = new Error('down');
            (err as NodeJS.ErrnoException).code = 'ECONNREFUSED';
            throw err;
          }),
      },
    });
    const opened: string[] = [];
    plugin.machineHooks.onCircuitOpen.on(({ spec }) => opened.push(spec.remoteName));

    const h = host(plugin, remote);
    const mod = await h.loadRemote<{ run(): Promise<string> }>(`${remote.name}/svc`);

    await expect(mod!.run()).rejects.toThrow('down');
    await expect(mod!.run()).rejects.toThrow('down');
    // Threshold reached: circuit is open, this call never hits the machine.
    await expect(mod!.run()).rejects.toBeInstanceOf(MachineCircuitOpenError);
    expect(attempts).toBe(2);
    expect(opened).toEqual([remote.name]);
  });

  test('circuit half-opens after resetMs and closes on success', async () => {
    const remote = uniqueRemote();
    let failing = true;
    const plugin = machinenPlugin({
      calls: { retries: 0, circuitBreaker: { threshold: 1, resetMs: 20 } },
      driver: {
        boot: async () =>
          fakeHandle(remote.name, async () => {
            if (failing) {
              const err = new Error('down');
              (err as NodeJS.ErrnoException).code = 'ECONNREFUSED';
              throw err;
            }
            return 'back';
          }),
      },
    });
    const closed: string[] = [];
    plugin.machineHooks.onCircuitClose.on(({ spec }) => closed.push(spec.remoteName));

    const h = host(plugin, remote);
    const mod = await h.loadRemote<{ run(): Promise<string> }>(`${remote.name}/svc`);

    await expect(mod!.run()).rejects.toThrow('down');
    await expect(mod!.run()).rejects.toBeInstanceOf(MachineCircuitOpenError);

    failing = false;
    await new Promise((r) => setTimeout(r, 30));
    await expect(mod!.run()).resolves.toBe('back'); // half-open probe succeeds
    expect(closed).toEqual([remote.name]);
  });

  test('metrics() reports per-machine call statistics', async () => {
    const remote = uniqueRemote();
    const plugin = machinenPlugin({
      calls: { circuitBreaker: false },
      driver: { boot: async () => fakeHandle(remote.name, async () => 'ok') },
    });
    const h = host(plugin, remote);
    const mod = await h.loadRemote<{ run(): Promise<string> }>(`${remote.name}/svc`);
    await mod!.run();
    await mod!.run();

    const metrics = plugin.metrics();
    const m = metrics[remote.name];
    expect(m.calls).toBe(2);
    expect(m.errors).toBe(0);
    expect(m.p50Ms).toBeGreaterThanOrEqual(0);
    expect(m.p95Ms).toBeGreaterThanOrEqual(m.p50Ms);
  });
});

describe('version negotiation', () => {
  function versionedDriver(name: string, version: string) {
    return {
      boot: async () => ({
        manifest: async () => ({ ...manifestFor(name), version }),
        call: async () => 'ok',
      }),
    };
  }

  test('satisfied version ranges attach fine', async () => {
    const remote = uniqueRemote();
    const plugin = machinenPlugin({ driver: versionedDriver(remote.name, '1.4.2') });
    const h = host(plugin, { ...remote, entry: `${remote.entry}?version=^1.0.0` });

    const mod = await h.loadRemote<{ run(): Promise<string> }>(`${remote.name}/svc`);
    await expect(mod!.run()).resolves.toBe('ok');
  });

  test('unsatisfied version ranges fail with a clear error', async () => {
    const remote = uniqueRemote();
    const plugin = machinenPlugin({ driver: versionedDriver(remote.name, '2.0.0') });
    const h = host(plugin, { ...remote, entry: `${remote.entry}?version=^1.0.0` });

    await expect(h.loadRemote(`${remote.name}/svc`)).rejects.toThrow(/\^1\.0\.0.*2\.0\.0/s);
  });
});

describe('MF runtime parity', () => {
  test('machines can be registered dynamically via registerRemotes', async () => {
    const remote = uniqueRemote();
    const plugin = machinenPlugin({
      driver: { boot: async () => fakeHandle(remote.name, async () => 'dynamic') },
    });
    const h = createInstance({ name: `host_${remote.name}`, remotes: [], plugins: [plugin] });

    h.registerRemotes([remote]);
    const mod = await h.loadRemote<{ run(): Promise<string> }>(`${remote.name}/svc`);
    await expect(mod!.run()).resolves.toBe('dynamic');
  });

  test('warm() pre-boots every known machine before first call', async () => {
    const remote = uniqueRemote();
    let boots = 0;
    const plugin = machinenPlugin({
      driver: {
        boot: async () => {
          boots++;
          return fakeHandle(remote.name, async () => 'ok');
        },
      },
    });
    host(plugin, remote);

    expect(boots).toBe(0);
    await plugin.warm();
    expect(boots).toBe(1);
  });
});
