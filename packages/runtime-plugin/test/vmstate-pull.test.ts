// packages/runtime-plugin/test/vmstate-pull.test.ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { resolvePullEntry } from '../src/artifacts.js';
import { createMachines, type MachinesClient } from '../src/client.js';
import { isMachinenSnapshotDir } from '../src/drivers/machinen.js';
import {
  parseMachineEntry,
  type MachineDriver,
  type MachineExposeManifest,
  type MachineHandle,
  type MachineSpec,
} from '../src/types.js';

const MANIFEST: MachineExposeManifest = {
  name: 'vm_machine',
  protocol: 3,
  version: '2.0.0',
  exposes: { './counter': { increment: { params: [], returns: 'number' } } },
};

// The MF runtime caches loaded remotes globally by name/module, so every
// test gets its own remote name + producer entry (client.test.ts pattern).
let testId = 0;
function unique() {
  testId++;
  return { name: `vm_machine_${testId}`, entry: `machinen://ignored-by-stub-${testId}.js` };
}

const FILES: Record<string, string> = {
  'meta.json': '{"machinen":"meta"}',
  'state.vmstate': `vm-heap-${'x'.repeat(64 * 1024)}`,
  'federated-machine.json': JSON.stringify({ remoteName: 'vm_machine', guestPort: 3801 }),
};

async function fakeSnapshotDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'e2e-snap-'));
  for (const [name, contents] of Object.entries(FILES)) {
    await writeFile(path.join(dir, name), contents);
  }
  return dir;
}

function producerDriver(snapDir: string): MachineDriver {
  const handle: MachineHandle = {
    manifest: async () => MANIFEST,
    call: async () => 2,
    snapshot: async () => ({ snapDir, image: 'base.tar.gz' }),
  };
  return { boot: async () => handle };
}

/** Records the spec it boots; "restores" by answering from the dir's presence. */
function recordingConsumerDriver(booted: MachineSpec[]): MachineDriver {
  return {
    boot: async (spec) => {
      booted.push(spec);
      if (spec.kind !== 'image' || !spec.image || !(await isMachinenSnapshotDir(spec.image))) {
        throw new Error(`recording driver expected a materialized snapshot dir, got "${spec.entry}"`);
      }
      return { manifest: async () => MANIFEST, call: async () => 3 };
    },
  };
}

describe('vmstate fork-by-pull, fakes for the VM only', () => {
  const clients: MachinesClient[] = [];
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(os.tmpdir(), 'e2e-cache-'));
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) {
      await client.plugin.disposeMachines();
    }
  });

  async function publishedProducer() {
    const { name, entry } = unique();
    const snapDir = await fakeSnapshotDir();
    const producer = createMachines({
      driver: producerDriver(snapDir),
      publish: { dir: await mkdtemp(path.join(os.tmpdir(), 'e2e-layout-')) },
      remotes: { [name]: entry },
    });
    clients.push(producer);
    await producer.machine(name).counter.increment(); // boot
    const published = await producer.plugin.publishMachine(name);
    return { producer, published, snapDir, name };
  }

  test('resolvePullEntry against the live endpoint materializes byte-identical state', async () => {
    const { published, snapDir, name } = await publishedProducer();

    const spec = parseMachineEntry(
      name,
      `machinen+pull+${published.url}?artifact=vmstate&version=^2.0.0`,
    );
    const resolution = await resolvePullEntry(spec, { cacheDir });

    expect(resolution.artifact).toBe('vmstate');
    expect(await isMachinenSnapshotDir(resolution.localPath)).toBe(true);
    for (const fileName of Object.keys(FILES)) {
      expect(await readFile(path.join(resolution.localPath, fileName))).toEqual(
        await readFile(path.join(snapDir, fileName)),
      );
    }
  });

  test('a full consumer client pulls, and its driver receives the materialized dir', async () => {
    const { published, name } = await publishedProducer();
    const booted: MachineSpec[] = [];

    const consumer = createMachines({
      driver: recordingConsumerDriver(booted),
      artifactCacheDir: cacheDir,
      remotes: { [name]: `machinen+pull+${published.url}?artifact=vmstate` },
    });
    clients.push(consumer);

    await expect(consumer.machine(name).counter.increment()).resolves.toBe(3);
    expect(booted).toHaveLength(1);
    expect(booted[0].kind).toBe('image');
    expect(booted[0].pulledFrom).toContain('machinen+pull+');
  });

  test('the root-mounted single-machine URL shape works too', async () => {
    const { published, name } = await publishedProducer();
    const rootUrl = published.url.replace(`/machines/${name}`, '');
    const booted: MachineSpec[] = [];

    const consumer = createMachines({
      driver: recordingConsumerDriver(booted),
      artifactCacheDir: cacheDir,
      remotes: { [name]: `machinen+pull+${rootUrl}?artifact=vmstate` },
    });
    clients.push(consumer);

    await expect(consumer.machine(name).counter.increment()).resolves.toBe(3);
  });

  test('two consumers pull the same digest; the second is served from its own cache dir', async () => {
    const { published, name } = await publishedProducer();

    const spec = (suffix: string) =>
      parseMachineEntry(name, `machinen+pull+${published.url}?artifact=vmstate${suffix}`);

    const first = await resolvePullEntry(spec(''), { cacheDir });
    const pinnedEntry = `&digest=${published.digest}`;
    const second = await resolvePullEntry(spec(pinnedEntry), { cacheDir });

    expect(first.localPath).toBe(second.localPath);
    expect(second.fromCache).toBe(true);
    expect(second.bytesFetched).toBe(0);
  });
});
