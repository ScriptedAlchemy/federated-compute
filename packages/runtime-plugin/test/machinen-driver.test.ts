// REAL machinen integration: boots an actual microVM (KVM) with the repo's
// real Node guest inside, exercises guest protocol v3 through a gvproxy port
// forward, snapshots the whole VM, and proves the counter continues across a
// kill + restore. No mocks anywhere — when machinen can't run on this host
// (no /dev/kvm, package not installed) the suite skips with the reason.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { machinenDriver } from '../src/drivers/machinen.js';
import { parseMachineEntry, type MachineHandle } from '../src/types.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const MACHINEN_BIN = path.join(PACKAGE_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'machinen.cmd' : 'machinen');
const GUEST_BUNDLE = path.join(REPO_ROOT, 'apps/remote/dist/index.js');
// Generous: cold boot ~5s + apt+node ~5s + snapshot ~7s + restore ~7s, but
// apt mirrors and first-time rootfs materialization can be much slower.
const FULL_CYCLE_TIMEOUT_MS = 300_000;

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
    // Base assets (kernel + debian rootfs) are a one-time fetch.
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
  console.warn(`[machinen-driver.test] skipping real-VM suite: ${unavailable}`);
}

function ensureGuestBundle(): void {
  if (existsSync(GUEST_BUNDLE)) return;
  const result = spawnSync('pnpm', ['--filter', 'remote', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('pnpm --filter remote build failed');
}

describe.skipIf(unavailable !== null)('machinenDriver (real microVMs)', () => {
  let snapshotDir: string | undefined;
  const liveHandles: MachineHandle[] = [];

  afterAll(async () => {
    // Kill by handle only — never pkill. Then verify the registry is clean
    // of our VMs and reclaim the ~2.5GB snapshot bundle.
    for (const handle of liveHandles) {
      await handle.dispose?.().catch(() => {});
    }
    const runtime = await import('@machinen/runtime');
    const leftovers = runtime.list().filter((entry) => entry.name?.startsWith('fc-vm_machine'));
    expect(leftovers).toEqual([]);
    if (snapshotDir) await rm(snapshotDir, { recursive: true, force: true });
  }, 60_000);

  test(
    'boots a real VM, serves protocol v3, and continues the counter across snapshot/kill/restore',
    async () => {
      ensureGuestBundle();
      snapshotDir = await mkdtemp(path.join(os.tmpdir(), 'machinen-driver-test-'));
      const driver = machinenDriver({ snapshotDir });

      // Cold boot: debian base + apt node + guest bundle, all inside the VM.
      const spec = parseMachineEntry('vm_machine', `machinen://${GUEST_BUNDLE}`);
      const handle = await driver.boot(spec);
      liveHandles.push(handle);

      const manifest = await handle.manifest();
      expect(manifest.protocol).toBe(3);
      expect(manifest.exposes['./counter']).toBeDefined();

      expect(await handle.call('./counter', 'increment', [])).toBe(1);
      expect(await handle.call('./counter', 'increment', [])).toBe(2);

      // fork is a documented amd64 0.4.0 upstream gap — must throw clearly.
      await expect(handle.fork!()).rejects.toThrow(/not supported on amd64/);

      // Freeze the whole VM (reseed stub + vmstate bundle), then kill it.
      const snap = (await handle.snapshot!()) as { snapDir: string; image: string };
      expect(existsSync(path.join(snap.snapDir, 'meta.json'))).toBe(true);
      expect(existsSync(path.join(snap.snapDir, 'state.vmstate'))).toBe(true);
      await handle.dispose!();

      // Restore: the entry now points at the snapshot bundle directory.
      const restoreSpec = parseMachineEntry('vm_machine', `machinen://${snap.snapDir}`);
      const restored = await driver.boot(restoreSpec);
      liveHandles.push(restored);

      // The counter lives in the guest process heap — 3 proves the VM
      // resumed mid-state instead of cold-booting.
      expect(await restored.call('./counter', 'increment', [])).toBe(3);
      expect((await restored.manifest()).protocol).toBe(3);
      await restored.dispose!();
    },
    FULL_CYCLE_TIMEOUT_MS,
  );
});
