import { afterEach, describe, expect, test } from 'vitest';
import { createMachines, envKeyFor } from '../src/client.js';
import { createGuestRuntime } from '../src/guest.js';
import { inProcessDriver } from '../src/drivers/in-process.js';
import type { MachineDriver } from '../src/types.js';

let testId = 0;
function unique(name: string) {
  testId++;
  return { name: `${name}_${testId}`, entry: `machinen://images/client-${name}-${testId}.img` };
}

function demoGuest(name: string) {
  return createGuestRuntime({
    name,
    version: '1.0.0',
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
        countdown: {
          handler: async function* (from: number) {
            for (let i = from; i >= 0; i--) yield i;
          },
          stream: true,
        },
      },
    },
  });
}

const cleanupEnv: string[] = [];
afterEach(() => {
  for (const key of cleanupEnv.splice(0)) delete process.env[key];
});

describe('createMachines facade', () => {
  test('machine.module.fn(...) feels like a local call', async () => {
    const { name, entry } = unique('simple');
    const client = createMachines({
      remotes: { [name]: entry },
      driver: inProcessDriver(demoGuest(name)),
    });

    const machine = client.machine<{ './math': { add(a: number, b: number): Promise<number> } }>(
      name,
    );
    await expect(machine.math.add(2, 3)).resolves.toBe(5);
    // './math' access style works too
    await expect(machine['./math'].add(1, 1)).resolves.toBe(2);
  });

  test('streaming functions are for-await-able directly', async () => {
    const { name, entry } = unique('stream');
    const client = createMachines({
      remotes: { [name]: entry },
      driver: inProcessDriver(demoGuest(name)),
    });

    const chunks: number[] = [];
    for await (const n of client.machine(name).math.countdown(2)) {
      chunks.push(n as number);
    }
    expect(chunks).toEqual([2, 1, 0]);
  });

  test('nothing boots until the first call', async () => {
    const { name, entry } = unique('lazy');
    let boots = 0;
    const base = inProcessDriver(demoGuest(name));
    const driver: MachineDriver = {
      boot: (spec) => {
        boots++;
        return base.boot(spec);
      },
    };
    const client = createMachines({ remotes: { [name]: entry }, driver });

    const fn = client.machine(name).math.add; // navigation alone is free
    expect(boots).toBe(0);
    await fn(1, 2);
    expect(boots).toBe(1);
  });

  test('remote addresses resolve from MACHINEN_REMOTE_* env vars', async () => {
    const { name, entry } = unique('envy');
    const envKey = envKeyFor(name);
    process.env[envKey] = entry;
    cleanupEnv.push(envKey);

    const client = createMachines({ driver: inProcessDriver(demoGuest(name)) });
    await expect(client.machine(name).math.add(4, 4)).resolves.toBe(8);
  });

  test('unknown machines fail with a helpful error', async () => {
    const client = createMachines({ driver: inProcessDriver(demoGuest('whatever')) });
    await expect(client.machine('ghost_machine').math.add(1, 2)).rejects.toThrow(
      /ghost_machine.*MACHINEN_REMOTE_GHOST_MACHINE/s,
    );
  });

  test('ops surface stays available: warm + metrics + hooks', async () => {
    const { name, entry } = unique('ops');
    let boots = 0;
    const base = inProcessDriver(demoGuest(name));
    const client = createMachines({
      remotes: { [name]: entry },
      driver: {
        boot: (spec) => {
          boots++;
          return base.boot(spec);
        },
      },
    });

    await client.warm();
    expect(boots).toBe(1);

    await client.machine(name).math.add(1, 1);
    expect(client.metrics()[name].calls).toBe(1);
    expect(typeof client.plugin.machineHooks.beforeCall.on).toBe('function');
  });
});
