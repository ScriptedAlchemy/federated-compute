// packages/runtime-plugin/test/publish.test.ts
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { publishSnapshotDir } from '../src/publish.js';
import type { MachineExposeManifest } from '../src/types.js';
import { VMSTATE_FORMAT, parseVmstateBundleManifest } from '../src/vmstate.js';

function hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const GUEST_MANIFEST: MachineExposeManifest = {
  name: 'vm_machine',
  protocol: 3,
  version: '1.2.0',
  artifacts: {
    image: { href: '/mf-image', format: 'guest-bundle', digest: `sha256:${'c'.repeat(64)}`, ext: '.js' },
  },
  exposes: { './counter': { increment: { params: [], returns: 'number' } } },
};

const FILES: Record<string, Buffer> = {
  'meta.json': Buffer.from('{"machinen":"meta"}'),
  'state.vmstate': Buffer.from('vm-ram-'.repeat(2000)),
  'federated-machine.json': Buffer.from(JSON.stringify({ remoteName: 'vm_machine', guestPort: 3801 })),
};

async function fakeSnapshotDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'publish-snap-'));
  for (const [name, bytes] of Object.entries(FILES)) {
    await writeFile(path.join(dir, name), bytes);
  }
  return dir;
}

describe('publishSnapshotDir', () => {
  test('writes blobs, bundle.json, and a vmstate-only mf-manifest.json into the layout', async () => {
    const snapDir = await fakeSnapshotDir();
    const layoutDir = await mkdtemp(path.join(os.tmpdir(), 'publish-layout-'));

    const published = await publishSnapshotDir({
      snapDir,
      name: 'vm_machine',
      manifest: GUEST_MANIFEST,
      layoutDir,
    });

    const machineDir = path.join(layoutDir, 'machines', 'vm_machine');
    expect(published.machineDir).toBe(machineDir);

    // every snapshot file landed as a digest-named blob
    for (const bytes of Object.values(FILES)) {
      expect(existsSync(path.join(machineDir, 'blobs', 'sha256', hex(bytes)))).toBe(true);
    }

    // bundle.json digest IS the published digest
    const bundleText = await readFile(published.bundlePath, 'utf8');
    expect(published.digest).toBe(`sha256:${hex(bundleText)}`);
    const bundle = parseVmstateBundleManifest(bundleText, 'at published bundle');
    expect(bundle.name).toBe('vm_machine');
    expect(bundle.files).toHaveLength(3);
    expect(published.bytes).toBe(Object.values(FILES).reduce((sum, b) => sum + b.length, 0));

    // the published manifest keeps guest identity but carries ONLY vmstate
    const manifest = JSON.parse(
      await readFile(path.join(machineDir, 'mf-manifest.json'), 'utf8'),
    ) as MachineExposeManifest;
    expect(manifest.name).toBe('vm_machine');
    expect(manifest.version).toBe('1.2.0');
    expect(manifest.exposes['./counter']).toBeDefined();
    expect(manifest.artifacts?.vmstate).toEqual(published.descriptor);
    expect(manifest.artifacts?.image).toBeUndefined();
    expect(manifest.artifacts?.snapshot).toBeUndefined();

    // descriptor points at the bundle within the machine base
    expect(published.descriptor.href).toBe(
      `vmstate/${published.digest.replace(':', '-')}/bundle.json`,
    );
    expect(published.descriptor.format).toBe(VMSTATE_FORMAT);
  });

  test('republishing writes a second bundle and the manifest advertises the latest', async () => {
    // createdAt is part of the bundle bytes, so each publish gets its own
    // digest and bundle dir; blobs dedupe by content underneath.
    const snapDir = await fakeSnapshotDir();
    const layoutDir = await mkdtemp(path.join(os.tmpdir(), 'publish-layout-'));

    const first = await publishSnapshotDir({
      snapDir,
      name: 'vm_machine',
      manifest: GUEST_MANIFEST,
      layoutDir,
    });
    const second = await publishSnapshotDir({
      snapDir,
      name: 'vm_machine',
      manifest: GUEST_MANIFEST,
      layoutDir,
    });
    expect(existsSync(first.bundlePath)).toBe(true);
    expect(existsSync(second.bundlePath)).toBe(true);
    // the served manifest advertises the LATEST publish
    const manifest = JSON.parse(
      await readFile(path.join(first.machineDir, 'mf-manifest.json'), 'utf8'),
    ) as MachineExposeManifest;
    expect(manifest.artifacts?.vmstate?.digest).toBe(second.digest);
  });

  test('compatibility overrides land in the bundle', async () => {
    const snapDir = await fakeSnapshotDir();
    const layoutDir = await mkdtemp(path.join(os.tmpdir(), 'publish-layout-'));

    const published = await publishSnapshotDir({
      snapDir,
      name: 'vm_machine',
      manifest: GUEST_MANIFEST,
      layoutDir,
      compatibility: { platform: 'linux/never-arch', machinenRuntime: '9.9.9' },
    });
    const bundle = parseVmstateBundleManifest(
      await readFile(published.bundlePath, 'utf8'),
      'at published bundle',
    );
    expect(bundle.compatibility.platform).toBe('linux/never-arch');
    expect(bundle.compatibility.machinenRuntime).toBe('9.9.9');
    expect(published.descriptor.platform).toBe('linux/never-arch');
  });
});
