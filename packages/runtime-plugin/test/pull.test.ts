import { readdir } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createMachines, type MachinesClient } from '../src/client.js';
import { httpAttachDriver } from '../src/drivers/http.js';
import { processDriver } from '../src/drivers/process.js';
import { createGuestRuntime, serveGuest, type GuestServer } from '../src/guest.js';
import type { MachineSpec } from '../src/types.js';
import type { PullResolution } from '../src/artifacts.js';

const FIXTURE_IMAGE = path.resolve(import.meta.dirname, 'fixtures/pull-guest.mjs');

/**
 * End-to-end pull federation: an ORIGIN machine publishes artifacts, a
 * consumer's `machinen+pull+...` entry fetches them and boots an independent
 * CLONE through the ordinary process driver — fork-by-fetch, no hypervisor.
 */
describe('pull entries through the full plugin stack', () => {
  let cacheDir: string;
  let origin: GuestServer;
  let originCounter: { value: number };
  const clients: MachinesClient[] = [];

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(os.tmpdir(), 'mf-pull-e2e-'));
    originCounter = { value: 0 };
    const guest = createGuestRuntime({
      name: 'origin_machine',
      version: '1.2.3',
      exposes: {
        './counter': {
          increment: () => ++originCounter.value,
          current: () => originCounter.value,
        },
      },
      state: {
        dehydrate: () => ({ counter: originCounter.value }),
        rehydrate: (state) => {
          originCounter.value = (state as { counter: number }).counter;
        },
      },
    });
    origin = await serveGuest(guest, { port: 0, imagePath: FIXTURE_IMAGE });
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      await client.plugin.disposeMachines();
    }
    await origin.close().catch(() => {});
  });

  function consumer(entrySuffix: string, calls?: Parameters<typeof createMachines>[0]['calls']) {
    const machines = createMachines({
      driver: processDriver(),
      artifactCacheDir: cacheDir,
      remotes: { fork_machine: `machinen+pull+http://127.0.0.1:${origin.port}${entrySuffix}` },
      calls: calls ?? { timeoutMs: 5_000, retries: 1, backoffMs: 10, circuitBreaker: false },
    });
    clients.push(machines);
    return machines;
  }

  test('fork-by-fetch: the pulled snapshot boots a clone that continues, then diverges', async () => {
    // Work the origin warm.
    originCounter.value = 3;

    const machines = consumer('?artifact=snapshot&version=^1.0.0');
    const counter = machines.machine('fork_machine').counter;

    // The clone resumes exactly where the origin was...
    await expect(counter.current()).resolves.toBe(3);
    await expect(counter.increment()).resolves.toBe(4);
    // ...and the two histories diverge independently from there.
    expect(originCounter.value).toBe(3);
    originCounter.value = 100;
    await expect(counter.current()).resolves.toBe(4);

    // The cache holds the digest-addressed image and the materialized bundle.
    const cached = await readdir(cacheDir);
    expect(cached.some((f) => f.endsWith('.mjs'))).toBe(true);
    expect(cached.some((f) => f.endsWith('.snap'))).toBe(true);
  });

  test('cold image pull: the clone boots fresh from the fetched program', async () => {
    originCounter.value = 99; // must NOT travel: image pulls carry no state
    const machines = consumer('?artifact=image');
    const counter = machines.machine('fork_machine').counter;

    await expect(counter.current()).resolves.toBe(0);
    await expect(counter.increment()).resolves.toBe(1);
  });

  test('warm() pre-pulls the artifact and emits both artifact hooks', async () => {
    const machines = consumer('?artifact=snapshot');
    const events: { hook: string; spec: MachineSpec; resolution?: PullResolution }[] = [];
    machines.plugin.machineHooks.beforeArtifactFetch.on((ctx) => {
      events.push({ hook: 'before', ...ctx });
    });
    machines.plugin.machineHooks.onArtifactFetched.on((ctx) => {
      events.push({ hook: 'after', ...ctx });
    });

    await machines.warm();

    expect(events.map((e) => e.hook)).toEqual(['before', 'after']);
    expect(events[0].spec.kind).toBe('pull');
    const resolution = events[1].resolution!;
    expect(resolution.artifact).toBe('snapshot');
    expect(resolution.fromCache).toBe(false);
    expect(resolution.bytesFetched).toBeGreaterThan(0);
    expect(resolution.spec.kind).toBe('image');
    expect(resolution.spec.pulledFrom).toContain('machinen+pull+http://');

    // Warmed: calls work without further resolution.
    await expect(machines.machine('fork_machine').counter.current()).resolves.toBe(0);
  });

  test('restartOnCrash reboots from the cached artifact — no re-pull, origin may be gone', async () => {
    originCounter.value = 3;
    const machines = consumer('?artifact=snapshot');
    const clone = machines.machine('fork_machine');

    await expect(clone.counter.current()).resolves.toBe(3);
    await expect(clone.counter.increment()).resolves.toBe(4);

    // The origin disappears entirely; only the local cache remains.
    await origin.close();

    await expect(clone.admin.die()).resolves.toBe('dying');
    await sleep(200); // let the clone actually exit

    // The next call crashes through to restartOnCrash, which must reboot
    // from the memoized resolution: the SAME materialized snapshot bundle.
    // Divergent clone state (4) is lost; the pulled state (3) returns.
    await expect(clone.counter.current()).resolves.toBe(3);
  });

  test('a pull entry with the attach-only driver fails with the driver error, not something cryptic', async () => {
    const machines = createMachines({
      driver: httpAttachDriver(),
      artifactCacheDir: cacheDir,
      remotes: { fork_machine: `machinen+pull+http://127.0.0.1:${origin.port}?artifact=image` },
    });
    clients.push(machines);

    await expect(machines.machine('fork_machine').counter.current()).rejects.toThrow(
      /httpAttachDriver expects/,
    );
  });

  test('pulling from an origin that publishes no artifacts fails with the attach hint', async () => {
    const bare = createGuestRuntime({
      name: 'bare_machine',
      exposes: { './math': { add: (a: number, b: number) => a + b } },
    });
    const bareServer = await serveGuest(bare, { port: 0 });
    try {
      const machines = createMachines({
        driver: processDriver(),
        artifactCacheDir: cacheDir,
        remotes: { fork_machine: `machinen+pull+http://127.0.0.1:${bareServer.port}` },
      });
      clients.push(machines);
      await expect(machines.machine('fork_machine').math.add(1, 2)).rejects.toThrow(
        /publishes no "image" artifact/,
      );
    } finally {
      await bareServer.close();
    }
  });
});
