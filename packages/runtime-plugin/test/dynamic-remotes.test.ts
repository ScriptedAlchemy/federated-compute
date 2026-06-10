import { describe, expect, test } from 'vitest';
import { createInstance } from '@module-federation/runtime';
import { machinenPlugin } from '../src/index.js';
import type { MachineDriver } from '../src/types.js';

// The MF runtime caches loaded remote entries globally (per entry string), so
// each test uses a unique remote name + entry to stay isolated.
let testId = 0;

function uniqueRemote() {
  testId++;
  return {
    name: `dyn_machine_${testId}`,
    entry: `machinen://images/dyn-${testId}.img`,
  };
}

function countingDriver(name: string, counters: { boots: number }): MachineDriver {
  return {
    boot: async () => {
      counters.boots++;
      return {
        manifest: async () => ({
          name,
          protocol: 3 as const,
          version: '1.0.0',
          exposes: { './svc': { run: { params: [], returns: 'string' } } },
        }),
        call: async () => 'ok',
      };
    },
  };
}

describe('dynamically registered remotes', () => {
  test('warm by name boots a machine registered via instance.registerRemotes', async () => {
    const remote = uniqueRemote();
    const counters = { boots: 0 };
    const plugin = machinenPlugin({ driver: countingDriver(remote.name, counters) });
    const host = createInstance({
      name: `host_${remote.name}`,
      remotes: [],
      plugins: [plugin],
    });

    host.registerRemotes([remote]);
    expect(counters.boots).toBe(0);

    // String form: the plugin must have learned the entry from registration —
    // no loadRemote has happened.
    await plugin.warm([remote.name]);
    expect(counters.boots).toBe(1);

    // The warmed machine is reused by loadRemote (no second boot).
    const mod = await host.loadRemote<{ run(): Promise<string> }>(`${remote.name}/svc`);
    await expect(mod!.run()).resolves.toBe('ok');
    expect(counters.boots).toBe(1);
  });

  test('warm of an unknown machine still throws a helpful error', async () => {
    const remote = uniqueRemote();
    const plugin = machinenPlugin({ driver: countingDriver(remote.name, { boots: 0 }) });
    createInstance({
      name: `host_${remote.name}`,
      remotes: [],
      plugins: [plugin],
    });

    await expect(plugin.warm([`ghost_${remote.name}`])).rejects.toThrow(
      `cannot warm unknown machine "ghost_${remote.name}"`,
    );
  });

  test('non-machine remotes registered at runtime are not claimed', async () => {
    const remote = uniqueRemote();
    const counters = { boots: 0 };
    const plugin = machinenPlugin({ driver: countingDriver(remote.name, counters) });
    const host = createInstance({
      name: `host_${remote.name}`,
      remotes: [],
      plugins: [plugin],
    });

    host.registerRemotes([
      { name: `js_${remote.name}`, entry: 'http://localhost:9999/remoteEntry.js' },
    ]);

    // The plugin must not learn http remotes, so string-warm of one throws.
    await expect(plugin.warm([`js_${remote.name}`])).rejects.toThrow(
      'cannot warm unknown machine',
    );
    expect(counters.boots).toBe(0);
  });
});
