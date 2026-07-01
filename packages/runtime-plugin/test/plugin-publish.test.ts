// packages/runtime-plugin/test/plugin-publish.test.ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createMachines, type MachinesClient } from '../src/client.js';
import type { MachineDriver, MachineExposeManifest, MachineHandle } from '../src/types.js';

const MANIFEST: MachineExposeManifest = {
  name: 'pub_machine',
  protocol: 3,
  version: '1.0.0',
  exposes: { './counter': { current: { params: [], returns: 'number' } } },
};
const SHELL = {
  rootfsDigest: `sha256:${'1'.repeat(64)}`,
  kernelDigest: `sha256:${'2'.repeat(64)}`,
};

// The MF runtime caches loaded remotes globally by name/module, so every
// test gets its own remote name + entry (same pattern as client.test.ts).
let testId = 0;
function unique() {
  testId++;
  return { name: `pub_machine_${testId}`, entry: `machinen://ignored-by-stub-${testId}.js` };
}

async function fakeSnapshotDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'plugin-pub-snap-'));
  await writeFile(path.join(dir, 'meta.json'), '{"machinen":"meta"}');
  await writeFile(path.join(dir, 'state.vmstate'), 'fake-vm-state-'.repeat(100));
  await writeFile(
    path.join(dir, 'federated-machine.json'),
    JSON.stringify({ remoteName: 'pub_machine', guestPort: 3801 }),
  );
  return dir;
}

/** A driver whose handle snapshots into a prepared machinen-shaped dir. */
function stubVmDriver(snapDir: string, snapshots: unknown[] = []): MachineDriver {
  const handle: MachineHandle = {
    manifest: async () => MANIFEST,
    call: async () => 7,
    snapshot: async () => {
      const result = { snapDir, image: 'base.tar.gz', shell: SHELL };
      snapshots.push(result);
      return result;
    },
  };
  return { boot: async () => handle };
}

function stubVmDriverWithoutShell(snapDir: string): MachineDriver {
  const handle: MachineHandle = {
    manifest: async () => MANIFEST,
    call: async () => 7,
    snapshot: async () => ({ snapDir, image: 'base.tar.gz' }),
  };
  return { boot: async () => handle };
}

const clients: MachinesClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.plugin.disposeMachines();
  }
});

describe('plugin.publishMachine', () => {
  async function bootedPublisher() {
    const { name, entry } = unique();
    const layoutDir = await mkdtemp(path.join(os.tmpdir(), 'plugin-pub-layout-'));
    const machines = createMachines({
      driver: stubVmDriver(await fakeSnapshotDir()),
      publish: { dir: layoutDir },
      remotes: { [name]: entry },
    });
    clients.push(machines);
    await expect(machines.machine(name).counter.current()).resolves.toBe(7);
    return { machines, name };
  }

  test('snapshots, publishes, lazily starts the endpoint, and serves the merged manifest', async () => {
    const { machines, name } = await bootedPublisher();
    const events: string[] = [];
    machines.plugin.machineHooks.beforePublish.on(() => void events.push('beforePublish'));
    machines.plugin.machineHooks.beforeSnapshot.on(() => void events.push('beforeSnapshot'));
    machines.plugin.machineHooks.onSnapshotted.on(() => void events.push('onSnapshotted'));
    machines.plugin.machineHooks.onPublished.on(({ published }) => {
      events.push('onPublished');
      expect(published.url).toMatch(
        new RegExp(`^http://127\\.0\\.0\\.1:\\d+/machines/${name}$`),
      );
    });

    const published = await machines.plugin.publishMachine(name);

    expect(events).toEqual(['beforePublish', 'beforeSnapshot', 'onSnapshotted', 'onPublished']);
    expect(published.digest).toMatch(/^sha256:[a-f0-9]{64}$/);

    // The endpoint is live and serves the guest manifest + vmstate artifact.
    const manifest = (await (
      await fetch(`${published.url}/mf-manifest.json`)
    ).json()) as MachineExposeManifest;
    expect(manifest.name).toBe('pub_machine');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.artifacts?.vmstate?.digest).toBe(published.digest);

    // Root mount also works while it is the only published machine.
    expect(
      (await fetch(`${published.url.replace(`/machines/${name}`, '')}/mf-manifest.json`)).status,
    ).toBe(200);
  });

  test('disposeMachines closes the endpoint', async () => {
    const { machines, name } = await bootedPublisher();
    const published = await machines.plugin.publishMachine(name);
    await machines.plugin.disposeMachines();

    await expect(fetch(`${published.url}/mf-manifest.json`)).rejects.toThrow();
  });

  test('publishMachine without publish options fails with configuration guidance', async () => {
    const { name, entry } = unique();
    const machines = createMachines({
      driver: stubVmDriver(await fakeSnapshotDir()),
      remotes: { [name]: entry },
    });
    clients.push(machines);
    await machines.machine(name).counter.current();

    await expect(machines.plugin.publishMachine(name)).rejects.toThrow(
      /publish options.*createMachines\(\{ publish/s,
    );
  });

  test('a non-vmstate snapshot (no machinen bundle dir) is refused with the driver hint', async () => {
    const { name, entry } = unique();
    const notASnapDir = await mkdtemp(path.join(os.tmpdir(), 'plugin-pub-not-snap-'));
    const machines = createMachines({
      driver: stubVmDriver(notASnapDir), // dir exists but has no meta.json/state.vmstate
      publish: { dir: await mkdtemp(path.join(os.tmpdir(), 'plugin-pub-layout-')) },
      remotes: { [name]: entry },
    });
    clients.push(machines);
    await machines.machine(name).counter.current();

    await expect(machines.plugin.publishMachine(name)).rejects.toThrow(
      /machinenDriver/,
    );
  });

  test('a vmstate snapshot without a shell identity is refused', async () => {
    const { name, entry } = unique();
    const machines = createMachines({
      driver: stubVmDriverWithoutShell(await fakeSnapshotDir()),
      publish: { dir: await mkdtemp(path.join(os.tmpdir(), 'plugin-pub-layout-')) },
      remotes: { [name]: entry },
    });
    clients.push(machines);
    await machines.machine(name).counter.current();

    await expect(machines.plugin.publishMachine(name)).rejects.toThrow(
      /MachineN shell identity/,
    );
  });
});
