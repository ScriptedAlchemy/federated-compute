import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  configureMachines,
  createMachines,
  envKeyFor,
  getMachines,
  machineModule,
  resetMachines,
} from '../src/client.js';
import { MachineVersionError } from '../src/errors.js';
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

type MathModule = {
  add(a: number, b: number): Promise<number>;
  countdown(from: number): AsyncIterable<number>;
};

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

describe('client-level version pinning', () => {
  test('warm() enforces options.versions against the machine manifest', async () => {
    const { name, entry } = unique('verfail');
    const client = createMachines({
      remotes: { [name]: entry },
      versions: { [name]: '^9.0.0' },
      driver: inProcessDriver(demoGuest(name)),
    });

    await expect(client.warm()).rejects.toThrow(MachineVersionError);
  });

  test('warm() succeeds when options.versions is satisfied', async () => {
    const { name, entry } = unique('verok');
    const client = createMachines({
      remotes: { [name]: entry },
      versions: { [name]: '^1.0.0' },
      driver: inProcessDriver(demoGuest(name)),
    });

    await client.warm();
    await expect(client.machine(name).math.add(1, 2)).resolves.toBe(3);
  });

  test('an explicit ?version= on the entry wins over options.versions', async () => {
    const { name, entry } = unique('verentry');
    const client = createMachines({
      remotes: { [name]: `${entry}?version=^1.0.0` },
      versions: { [name]: '^9.0.0' },
      driver: inProcessDriver(demoGuest(name)),
    });

    await expect(client.warm()).resolves.toBeUndefined();
  });

  test('options.versions wins over the per-module version pin', async () => {
    const { name, entry } = unique('veropts');
    const client = createMachines({
      remotes: { [name]: entry },
      versions: { [name]: '^9.0.0' },
      driver: inProcessDriver(demoGuest(name)),
    });

    await expect(client.machine(name, { version: '^1.0.0' }).math.add(1, 2)).rejects.toThrow(
      MachineVersionError,
    );
  });
});

describe('machineModule bindings', () => {
  beforeEach(() => resetMachines());
  afterEach(() => resetMachines());

  test('stream functions return a real AsyncIterable, not a thenable', async () => {
    const { name, entry } = unique('mm_stream');
    configureMachines({ remotes: { [name]: entry }, driver: inProcessDriver(demoGuest(name)) });
    const math = machineModule<MathModule>(name, './math', { streams: ['countdown'] });

    const result = math.countdown(2);
    expect(result instanceof Promise).toBe(false);
    expect((result as { then?: unknown }).then).toBeUndefined();

    const chunks: number[] = [];
    for await (const n of result) chunks.push(n);
    expect(chunks).toEqual([2, 1, 0]);
  });

  test('unary functions return a true Promise', async () => {
    const { name, entry } = unique('mm_unary');
    configureMachines({ remotes: { [name]: entry }, driver: inProcessDriver(demoGuest(name)) });
    const math = machineModule<MathModule>(name, './math', { streams: ['countdown'] });

    const result = math.add(2, 3);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe(5);
  });
});

describe('default client', () => {
  beforeEach(() => resetMachines());
  afterEach(() => resetMachines());

  test('configureMachines + machineModule works end to end', async () => {
    const { name, entry } = unique('dc_e2e');
    configureMachines({ remotes: { [name]: entry }, driver: inProcessDriver(demoGuest(name)) });

    const math = machineModule<MathModule>(name, './math', { streams: ['countdown'] });
    await expect(math.add(20, 22)).resolves.toBe(42);
  });

  test('generated module versions are registered before default warm()', async () => {
    const { name, entry } = unique('dc_warm_pin');
    configureMachines({ remotes: { [name]: entry }, driver: inProcessDriver(demoGuest(name)) });

    machineModule<MathModule>(name, './math', { version: '^9.0.0' });

    await expect(getMachines().warm()).rejects.toThrow(MachineVersionError);
  });

  test('configureMachines after first use throws', async () => {
    const { name, entry } = unique('dc_late');
    configureMachines({ remotes: { [name]: entry }, driver: inProcessDriver(demoGuest(name)) });
    await machineModule<MathModule>(name, './math').add(1, 1);

    expect(() => configureMachines({})).toThrow(/before any machine call/);
  });

  test('resetMachines allows reconfiguration', async () => {
    const a = unique('dc_reset_a');
    configureMachines({ remotes: { [a.name]: a.entry }, driver: inProcessDriver(demoGuest(a.name)) });
    await expect(machineModule<MathModule>(a.name, './math').add(1, 2)).resolves.toBe(3);
    expect(() => configureMachines({})).toThrow();

    resetMachines();
    const b = unique('dc_reset_b');
    configureMachines({ remotes: { [b.name]: b.entry }, driver: inProcessDriver(demoGuest(b.name)) });
    await expect(machineModule<MathModule>(b.name, './math').add(3, 4)).resolves.toBe(7);
  });

  test('remote addresses resolve from env vars through the default client', async () => {
    const { name, entry } = unique('dc_env');
    const envKey = envKeyFor(name);
    process.env[envKey] = entry;
    cleanupEnv.push(envKey);

    configureMachines({ driver: inProcessDriver(demoGuest(name)) });
    await expect(machineModule<MathModule>(name, './math').add(5, 5)).resolves.toBe(10);
  });
});
