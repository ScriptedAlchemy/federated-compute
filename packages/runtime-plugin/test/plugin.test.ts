import { describe, expect, test } from 'vitest';
import { createInstance } from '@module-federation/runtime';
import { machinenPlugin } from '../src/index.js';
import { createGuestRuntime } from '../src/guest.js';
import { inProcessDriver } from '../src/drivers/in-process.js';

// The MF runtime caches loaded remote entries globally (per entry), so each
// test uses a unique remote name + entry to stay isolated.
let testId = 0;

function uniqueRemote() {
  testId++;
  return {
    name: `math_machine_${testId}`,
    entry: `machinen://images/math-${testId}.tar.gz?cpus=1`,
  };
}

function mathGuest(name: string) {
  return createGuestRuntime({
    name,
    exposes: {
      './math': {
        add: (a: number, b: number) => a + b,
        fib: (n: number): number => (n <= 1 ? n : 2),
      },
    },
  });
}

function createHost(
  plugin: ReturnType<typeof machinenPlugin>,
  remote: { name: string; entry: string },
) {
  return createInstance({
    name: `host_${remote.name}`,
    remotes: [remote],
    plugins: [plugin],
  });
}

describe('machinenPlugin', () => {
  test('loadRemote returns callable function bindings backed by the machine', async () => {
    const remote = uniqueRemote();
    const plugin = machinenPlugin({ driver: inProcessDriver(mathGuest(remote.name)) });
    const host = createHost(plugin, remote);

    const mod = await host.loadRemote<{
      add: (a: number, b: number) => Promise<number>;
    }>(`${remote.name}/math`);

    expect(mod).toBeTruthy();
    await expect(mod!.add(2, 3)).resolves.toBe(5);
  });

  test('unknown function rejects', async () => {
    const remote = uniqueRemote();
    const plugin = machinenPlugin({ driver: inProcessDriver(mathGuest(remote.name)) });
    const host = createHost(plugin, remote);

    const mod = await host.loadRemote<Record<string, (...a: unknown[]) => Promise<unknown>>>(
      `${remote.name}/math`,
    );
    expect(mod).toBeTruthy();
    expect(typeof mod!.add).toBe('function');
    expect(mod!.missing).toBeUndefined();
  });

  test('custom machine lifecycle hooks fire in order', async () => {
    const events: string[] = [];
    const remote = uniqueRemote();
    const plugin = machinenPlugin({ driver: inProcessDriver(mathGuest(remote.name)) });

    plugin.machineHooks.beforeMachineBoot.on(({ spec }) => {
      events.push(`boot:${spec.remoteName}`);
    });
    plugin.machineHooks.onMachineReady.on(({ spec }) => {
      events.push(`ready:${spec.remoteName}`);
    });
    plugin.machineHooks.beforeCall.on(({ fn }) => {
      events.push(`before:${fn}`);
    });
    plugin.machineHooks.afterCall.on(({ fn, result }) => {
      events.push(`after:${fn}=${String(result)}`);
    });

    const host = createHost(plugin, remote);
    const mod = await host.loadRemote<{ add: (a: number, b: number) => Promise<number> }>(
      `${remote.name}/math`,
    );
    await mod!.add(1, 2);

    expect(events).toEqual([
      `boot:${remote.name}`,
      `ready:${remote.name}`,
      'before:add',
      'after:add=3',
    ]);
  });

  test('beforeCall can rewrite args, onMachineError fires on guest failure', async () => {
    const remote = uniqueRemote();
    const guest = createGuestRuntime({
      name: remote.name,
      exposes: {
        './math': {
          add: (a: number, b: number) => a + b,
          boom: () => {
            throw new Error('guest exploded');
          },
        },
      },
    });
    const plugin = machinenPlugin({ driver: inProcessDriver(guest) });
    plugin.machineHooks.beforeCall.on((ctx) => {
      ctx.args = (ctx.args as number[]).map((n) => n * 10);
    });
    const errors: string[] = [];
    plugin.machineHooks.onMachineError.on(({ fn, error }) => {
      errors.push(`${fn}:${(error as Error).message}`);
    });

    const host = createHost(plugin, remote);
    const mod = await host.loadRemote<{
      add: (a: number, b: number) => Promise<number>;
      boom: () => Promise<void>;
    }>(`${remote.name}/math`);

    await expect(mod!.add(1, 2)).resolves.toBe(30);
    await expect(mod!.boom()).rejects.toThrow('guest exploded');
    expect(errors).toEqual(['boom:guest exploded']);
  });

  test('machine boots once across multiple module loads', async () => {
    let boots = 0;
    const remote = uniqueRemote();
    const base = inProcessDriver(mathGuest(remote.name));
    const plugin = machinenPlugin({
      driver: {
        boot: async (spec) => {
          boots++;
          return base.boot(spec);
        },
      },
    });
    const host = createHost(plugin, remote);

    await host.loadRemote(`${remote.name}/math`);
    await host.loadRemote(`${remote.name}/math`);
    expect(boots).toBe(1);
  });

  test('streaming functions are bound as async iterables', async () => {
    const remote = uniqueRemote();
    const guest = createGuestRuntime({
      name: remote.name,
      exposes: {
        './streams': {
          countdown: {
            handler: async function* (from: number) {
              for (let i = from; i >= 0; i--) yield i;
            },
            stream: true,
          },
        },
      },
    });
    const plugin = machinenPlugin({ driver: inProcessDriver(guest) });
    const host = createHost(plugin, remote);

    const mod = await host.loadRemote<{ countdown(from: number): AsyncIterable<number> }>(
      `${remote.name}/streams`,
    );
    const chunks: number[] = [];
    for await (const n of mod!.countdown(2)) chunks.push(n);
    expect(chunks).toEqual([2, 1, 0]);
  });

  test('transport failure emits onMachineCrash and restartOnCrash reboots once', async () => {
    const remote = uniqueRemote();
    let boots = 0;
    let failNextCall = false;
    const plugin = machinenPlugin({
      restartOnCrash: true,
      driver: {
        boot: async () => {
          boots++;
          return {
            manifest: async () => ({
              name: remote.name,
              protocol: 3 as const,
              version: '1.0.0',
              exposes: { './math': { add: { params: [], returns: 'number' } } },
            }),
            call: async (_m: string, _f: string, args: unknown[]) => {
              if (failNextCall) {
                failNextCall = false;
                const err = new Error('connection refused');
                (err as NodeJS.ErrnoException).code = 'ECONNREFUSED';
                throw err;
              }
              return (args as number[]).reduce((a, b) => a + b, 0);
            },
          };
        },
      },
    });
    const crashes: string[] = [];
    plugin.machineHooks.onMachineCrash.on(({ spec }) => crashes.push(spec.remoteName));

    const host = createHost(plugin, remote);
    const mod = await host.loadRemote<{ add(...n: number[]): Promise<number> }>(
      `${remote.name}/math`,
    );

    await expect(mod!.add(1, 2)).resolves.toBe(3);
    failNextCall = true;
    // Crash on this call -> plugin reboots the machine and retries once.
    await expect(mod!.add(4, 5)).resolves.toBe(9);
    expect(boots).toBe(2);
    expect(crashes).toEqual([remote.name]);
  });

  test('snapshot and fork delegate to the handle and fire hooks', async () => {
    const remote = uniqueRemote();
    const events: string[] = [];
    const plugin = machinenPlugin({
      driver: {
        boot: async () => ({
          manifest: async () => ({
            name: remote.name,
            protocol: 3 as const,
            version: '1.0.0',
            exposes: { './math': { add: { params: [], returns: 'number' } } },
          }),
          call: async () => 0,
          snapshot: async () => ({ snapDir: '/tmp/snap-1' }),
          fork: async () => ({ name: `${remote.name}-fork` }),
        }),
      },
    });
    plugin.machineHooks.beforeSnapshot.on(({ spec }) => events.push(`snap:${spec.remoteName}`));
    plugin.machineHooks.onSnapshotted.on(({ snapshot }) =>
      events.push(`snapped:${(snapshot as { snapDir: string }).snapDir}`),
    );
    plugin.machineHooks.onForked.on(({ fork }) =>
      events.push(`forked:${(fork as { name: string }).name}`),
    );

    const host = createHost(plugin, remote);
    await host.loadRemote(`${remote.name}/math`);

    const snapshot = await plugin.snapshotMachine(remote.name);
    expect(snapshot).toEqual({ snapDir: '/tmp/snap-1' });
    const fork = await plugin.forkMachine(remote.name);
    expect(fork).toEqual({ name: `${remote.name}-fork` });
    expect(events).toEqual([
      `snap:${remote.name}`,
      'snapped:/tmp/snap-1',
      `forked:${remote.name}-fork`,
    ]);
  });

  test('disposeMachines disposes every booted machine', async () => {
    let disposed = 0;
    const remote = uniqueRemote();
    const base = inProcessDriver(mathGuest(remote.name));
    const plugin = machinenPlugin({
      driver: {
        boot: async (spec) => {
          const handle = await base.boot(spec);
          return { ...handle, dispose: async () => void disposed++ };
        },
      },
    });
    const host = createHost(plugin, remote);
    await host.loadRemote(`${remote.name}/math`);

    await plugin.disposeMachines();
    expect(disposed).toBe(1);
  });
});
