// packages/runtime-plugin/test/vmstate.test.ts
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  VMSTATE_FORMAT,
  buildVmstateBundle,
  ociHostPlatform,
  parseVmstateBundleManifest,
  sha256File,
  type VmstateCompatibility,
} from '../src/vmstate.js';

const COMPAT: VmstateCompatibility = {
  platform: 'linux/amd64',
  machinenRuntime: '0.4.0',
  vmstateFormat: VMSTATE_FORMAT,
  snapshotEngine: 'machinen-default',
  reseed: 'machinen-0.4.0-shim@1',
};

function hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fakeSnapshotDir(): Promise<{ dir: string; files: Record<string, Buffer> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vmstate-snap-'));
  const files = {
    'meta.json': Buffer.from('{"machinen":"meta"}'),
    'state.vmstate': Buffer.from('fake-vm-ram-and-disk-'.repeat(1000)),
    'federated-machine.json': Buffer.from(
      JSON.stringify({ remoteName: 'vm_machine', guestPort: 3801, image: 'base.tar.gz', snappedAt: 'now' }),
    ),
  };
  for (const [name, bytes] of Object.entries(files)) {
    await writeFile(path.join(dir, name), bytes);
  }
  return { dir, files };
}

describe('ociHostPlatform', () => {
  test('maps node arch to OCI vocabulary', () => {
    const platform = ociHostPlatform();
    expect(platform).toBe(
      `${process.platform}/${process.arch === 'x64' ? 'amd64' : process.arch}`,
    );
    expect(platform).not.toContain('x64');
  });
});

describe('buildVmstateBundle', () => {
  test('hashes every file of a snapshot dir into sorted, digest-true entries', async () => {
    const { dir, files } = await fakeSnapshotDir();
    const built = await buildVmstateBundle(dir, { name: 'vm_machine', compatibility: COMPAT });

    expect(built.manifest.format).toBe(VMSTATE_FORMAT);
    expect(built.manifest.name).toBe('vm_machine');
    expect(built.manifest.compatibility).toEqual(COMPAT);
    expect(built.manifest.files.map((f) => f.path)).toEqual([
      'federated-machine.json',
      'meta.json',
      'state.vmstate',
    ]);
    for (const entry of built.manifest.files) {
      const bytes = files[entry.path];
      expect(entry.digest).toBe(`sha256:${hex(bytes)}`);
      expect(entry.bytes).toBe(bytes.length);
      expect(entry.href).toBe(`blobs/sha256/${hex(bytes)}`);
    }
    // sources line up with manifest.files, same order.
    expect(built.sources).toEqual(built.manifest.files.map((f) => path.join(dir, f.path)));
  });

  test('walks nested directories', async () => {
    const { dir } = await fakeSnapshotDir();
    await mkdir(path.join(dir, 'extra'), { recursive: true });
    await writeFile(path.join(dir, 'extra', 'disk.img'), 'nested');
    const built = await buildVmstateBundle(dir, { name: 'vm_machine', compatibility: COMPAT });
    expect(built.manifest.files.map((f) => f.path)).toContain('extra/disk.img');
  });

  test('rejects an empty snapshot dir', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vmstate-empty-'));
    await expect(
      buildVmstateBundle(dir, { name: 'vm_machine', compatibility: COMPAT }),
    ).rejects.toThrow(/contains no files/);
  });
});

describe('sha256File', () => {
  test('streams a file to its hex digest', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vmstate-hash-'));
    const file = path.join(dir, 'blob');
    await writeFile(file, 'digest me');
    expect(await sha256File(file)).toBe(hex('digest me'));
  });
});

describe('parseVmstateBundleManifest', () => {
  function valid(): Record<string, unknown> {
    return {
      format: VMSTATE_FORMAT,
      name: 'vm_machine',
      createdAt: new Date().toISOString(),
      compatibility: { ...COMPAT },
      files: [
        { path: 'meta.json', href: 'blobs/sha256/aa', digest: `sha256:${'a'.repeat(64)}`, bytes: 2 },
      ],
    };
  }

  test('round-trips a valid manifest', () => {
    const parsed = parseVmstateBundleManifest(JSON.stringify(valid()), 'at test://bundle');
    expect(parsed.name).toBe('vm_machine');
    expect(parsed.files).toHaveLength(1);
  });

  test.each([
    [{ format: 'oci-layout@7' }, /format "oci-layout@7"/],
    [{ name: '' }, /"name"/],
    [{ compatibility: undefined }, /"compatibility"/],
    [{ files: [] }, /"files" must be a non-empty array/],
  ])('rejects %j', (patch, message) => {
    expect(() =>
      parseVmstateBundleManifest(JSON.stringify({ ...valid(), ...patch }), 'at test://bundle'),
    ).toThrow(message);
  });

  test('rejects path traversal and absolute paths in file entries', () => {
    for (const evil of ['../../etc/passwd', '/etc/passwd', 'a/../b', 'a\\b', '..']) {
      const manifest = valid();
      (manifest.files as { path: string }[])[0].path = evil;
      expect(() =>
        parseVmstateBundleManifest(JSON.stringify(manifest), 'at test://bundle'),
      ).toThrow(/not a safe relative path/);
    }
  });

  test('rejects duplicate file paths', () => {
    const manifest = valid();
    (manifest.files as unknown[]).push((manifest.files as unknown[])[0]);
    expect(() =>
      parseVmstateBundleManifest(JSON.stringify(manifest), 'at test://bundle'),
    ).toThrow(/duplicate file path/);
  });

  test('rejects invalid digests and negative sizes', () => {
    const badDigest = valid();
    (badDigest.files as { digest: string }[])[0].digest = 'md5:abc';
    expect(() =>
      parseVmstateBundleManifest(JSON.stringify(badDigest), 'at test://bundle'),
    ).toThrow(/digest/);

    const badBytes = valid();
    (badBytes.files as { bytes: number }[])[0].bytes = -1;
    expect(() =>
      parseVmstateBundleManifest(JSON.stringify(badBytes), 'at test://bundle'),
    ).toThrow(/bytes/);
  });
});
