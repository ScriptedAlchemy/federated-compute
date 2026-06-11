// REAL machinen fork-by-pull: boots an actual microVM, publishes its whole
// VM through plugin.publishMachine(), pulls it back through a
// machinen+pull+...?artifact=vmstate entry, and proves the restored clone
// continues mid-heap and diverges. Skips with the reason when machinen
// cannot run here (same honesty contract as machinen-driver.test.ts).
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { createMachines, type MachinesClient } from '../src/client.js';
import { machinenDriver } from '../src/drivers/machinen.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const MACHINEN_BIN = path.join(
  PACKAGE_ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'machinen.cmd' : 'machinen',
);
const GUEST_BUNDLE = path.join(REPO_ROOT, 'apps/remote/dist/index.js');
// Producer cold boot + snapshot + two restores + local 2.5GB transfers.
const FULL_CYCLE_TIMEOUT_MS = 600_000;
const BOOT_TIMEOUT_MS = 300_000;

async function machinenUnavailableReason(): Promise<string | null> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    return `unsupported platform ${process.platform}`;
  }
  if (process.platform === 'linux') {
    if (!existsSync('/dev/kvm')) return 'no /dev/kvm on this host';
    try {
      accessSync('/dev/kvm', constants.R_OK | constants.W_OK);
    } catch {
      return '/dev/kvm exists but is not read/writable by this user';
    }
  }
  try {
    const runtime = await import('@machinen/runtime');
    try {
      runtime.resolveBaseRootfs();
    } catch {
      if (!existsSync(MACHINEN_BIN)) {
        return `repo-local machinen CLI missing at ${MACHINEN_BIN}; run pnpm install`;
      }
      const install = spawnSync(MACHINEN_BIN, ['install'], {
        cwd: PACKAGE_ROOT,
        stdio: 'inherit',
        timeout: 240_000,
      });
      if (install.status !== 0) return 'machinen install (base asset fetch) failed';
      runtime.resolveBaseRootfs();
    }
  } catch (error) {
    return `@machinen/runtime not loadable: ${(error as Error).message}`;
  }
  return null;
}

const unavailable = await machinenUnavailableReason();
if (unavailable) {
  console.warn(`[vmstate-machinen.test] skipping real-VM suite: ${unavailable}`);
}

function ensureGuestBundle(): void {
  if (existsSync(GUEST_BUNDLE)) return;
  const result = spawnSync('pnpm', ['--filter', 'remote', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('pnpm --filter remote build failed');
}

describe.skipIf(unavailable !== null)('vmstate fork-by-pull (real microVMs)', () => {
  const clients: MachinesClient[] = [];
  let work: string | undefined;

  afterAll(async () => {
    for (const client of clients) {
      await client.plugin.disposeMachines().catch(() => {});
    }
    const runtime = await import('@machinen/runtime');
    const leftovers = runtime.list().filter((entry) => entry.name?.startsWith('fc-vm_machine'));
    expect(leftovers).toEqual([]);
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
