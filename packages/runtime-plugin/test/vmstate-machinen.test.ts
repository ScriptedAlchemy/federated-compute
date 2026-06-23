// REAL machinen fork-by-pull: boots an actual microVM, publishes its whole
// VM through plugin.publishMachine(), pulls it back through a
// machinen+pull+...?artifact=vmstate entry, and proves the restored clone
// continues mid-heap and diverges. Skips with the reason when machinen
// cannot run here (same honesty contract as machinen-driver.test.ts).
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { createMachines, type MachinesClient } from '../src/client.js';
import { machinenDriver } from '../src/drivers/machinen.js';
import {
  GUEST_BUNDLE,
  ensureGuestBundle,
  expectNoMachinenVmLeftovers,
  machinenUnavailableReason,
} from './real-machinen.js';
// Producer cold boot + snapshot + two restores + local 2.5GB transfers.
const FULL_CYCLE_TIMEOUT_MS = 600_000;
const BOOT_TIMEOUT_MS = 300_000;

const unavailable = await machinenUnavailableReason();
if (unavailable) {
  console.warn(`[vmstate-machinen.test] skipping real-VM suite: ${unavailable}`);
}

describe.skipIf(unavailable !== null)('vmstate fork-by-pull (real microVMs)', () => {
  const clients: MachinesClient[] = [];
  let work: string | undefined;

  afterAll(async () => {
    for (const client of clients) {
      await client.plugin.disposeMachines().catch(() => {});
    }
    await expectNoMachinenVmLeftovers();
    if (work) await rm(work, { recursive: true, force: true });
  }, 120_000);

  test(
    'snapshot -> publish -> pull -> restore: clone continues mid-heap and diverges',
    async () => {
      ensureGuestBundle();
      work = await mkdtemp(path.join(os.tmpdir(), 'vmstate-e2e-'));

      // Producer: a real VM, counter worked to 2.
      const producer = createMachines({
        driver: machinenDriver({ snapshotDir: path.join(work, 'snaps') }),
        publish: { dir: path.join(work, 'registry'), port: 0 },
        bootTimeoutMs: BOOT_TIMEOUT_MS,
        remotes: { vm_machine: `machinen://${GUEST_BUNDLE}?memory=1024` },
      });
      clients.push(producer);
      const producerCounter = producer.machine('vm_machine').counter;
      await producerCounter.increment();
      await expect(producerCounter.increment()).resolves.toBe(2);

      const published = await producer.plugin.publishMachine('vm_machine');
      expect(published.digest).toMatch(/^sha256:[a-f0-9]{64}$/);

      // Consumer A: pull entry restores the whole VM; heap continues 2 -> 3.
      const consumerA = createMachines({
        driver: machinenDriver(),
        artifactCacheDir: path.join(work, 'cache-a'),
        bootTimeoutMs: BOOT_TIMEOUT_MS,
        remotes: { vm_machine: `machinen+pull+${published.url}?artifact=vmstate` },
      });
      clients.push(consumerA);
      await expect(consumerA.machine('vm_machine').counter.increment()).resolves.toBe(3);

      // Consumer B: same bundle, independent clone — also resumes at 2 -> 3.
      // Pulled through the root-mounted single-machine URL: same artifact,
      // but a DISTINCT entry string — the MF runtime caches loaded remotes
      // globally by name+entry, so a byte-identical entry would silently
      // reuse consumer A's container instead of booting a second clone.
      const rootUrl = published.url.replace('/machines/vm_machine', '');
      const consumerB = createMachines({
        driver: machinenDriver(),
        artifactCacheDir: path.join(work, 'cache-b'),
        bootTimeoutMs: BOOT_TIMEOUT_MS,
        remotes: { vm_machine: `machinen+pull+${rootUrl}?artifact=vmstate` },
      });
      clients.push(consumerB);
      await expect(consumerB.machine('vm_machine').counter.increment()).resolves.toBe(3);

      // Divergence: consumer A moves to 4 while consumer B stays at 3 —
      // independent clone histories from one frozen snapshot point. (If the
      // clones secretly shared a VM, B's earlier increment would have pushed
      // this to 5.)
      await expect(consumerA.machine('vm_machine').counter.increment()).resolves.toBe(4);

      // Upstream caveat, pinned so a fix gets noticed: @machinen/runtime's
      // API docs say vmstate checkpoints are non-destructive, but 0.4.0 on
      // amd64 empirically kills the source VM's guest at dump time (probed
      // directly; every other e2e in this repo disposes the source right
      // after snapshotting, which is why this never surfaced). The
      // producer's history therefore ENDS at the publish point, and
      // restartOnCrash reboots it FRESH from the entry image — counter 1.
      // When upstream makes dumps truly non-destructive this asserts 3:
      // delete the caveat and assert continuation instead.
      await expect(producerCounter.increment()).resolves.toBe(1);
    },
    FULL_CYCLE_TIMEOUT_MS,
  );
});
