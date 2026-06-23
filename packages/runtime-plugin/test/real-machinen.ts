import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const MACHINEN_BIN = path.join(
  PACKAGE_ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'machinen.cmd' : 'machinen',
);

export const GUEST_BUNDLE = path.join(REPO_ROOT, 'apps/remote/dist/index.js');

export async function machinenUnavailableReason(): Promise<string | null> {
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

export function ensureGuestBundle(): void {
  if (existsSync(GUEST_BUNDLE)) return;
  const result = spawnSync('pnpm', ['--filter', 'remote', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('pnpm --filter remote build failed');
}

export async function expectNoMachinenVmLeftovers(remoteName = 'vm_machine'): Promise<void> {
  const runtime = await import('@machinen/runtime');
  const vmNamePrefix = `fc-${remoteName}-${process.pid}-`;
  const leftovers = runtime.list().filter((entry) => entry.name?.startsWith(vmNamePrefix));
  expect(leftovers).toEqual([]);
}
