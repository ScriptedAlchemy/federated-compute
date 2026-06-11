// packages/runtime-plugin/test/vmstate.test.ts
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  VMSTATE_FORMAT,
  buildVmstateBundle,
  ensureBlobCached,
  installedMachinenRuntimeVersion,
  materializeVmstateDir,
  ociHostPlatform,
  parseVmstateBundleManifest,
  sha256File,
  vmstateCompatibilityError,
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

describe('vmstateCompatibilityError', () => {
  const host = { platform: 'linux/amd64', machinenRuntime: '0.4.0' };

  test('compatible bundle returns undefined', () => {
    expect(vmstateCompatibilityError(COMPAT, host)).toBeUndefined();
  });

  test('platform mismatch names both platforms', () => {
    const message = vmstateCompatibilityError(
      { ...COMPAT, platform: 'linux/arm64' },
      host,
    );
    expect(message).toMatch(/requires "linux\/arm64".*this host is "linux\/amd64"/s);
    expect(message).toMatch(/before download/);
  });

  test('runtime mismatch names both versions', () => {
    const message = vmstateCompatibilityError(
      { ...COMPAT, machinenRuntime: '0.5.1' },
      host,
    );
    expect(message).toMatch(/requires @machinen\/runtime 0\.5\.1.*installed 0\.4\.0/s);
  });

  test('unknown snapshot engine is rejected by name', () => {
    const message = vmstateCompatibilityError(
      { ...COMPAT, snapshotEngine: 'criu-experimental' },
      host,
    );
    expect(message).toMatch(/"criu-experimental"/);
  });
});

describe('installedMachinenRuntimeVersion', () => {
  test('reads the devDependency version without loading the native runtime', () => {
    // @machinen/runtime@0.4.0 is a devDependency of this package.
    expect(installedMachinenRuntimeVersion()).toBe('0.4.0');
  });
});

const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.all(closers.map((close) => close()));
});

async function serveBytes(routes: Record<string, Buffer>): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    const body = routes[req.url ?? ''];
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(body);
  });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
  );
  closers.push(() => new Promise((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${port}`, requests };
}

function entryFor(filePath: string, bytes: Buffer) {
  return {
    path: filePath,
    href: `blobs/sha256/${hex(bytes)}`,
    digest: `sha256:${hex(bytes)}`,
    bytes: bytes.length,
  };
}

describe('ensureBlobCached', () => {
  test('streams a download into the digest-named cache file', async () => {
    const bytes = Buffer.from('vmstate-blob-'.repeat(500));
    const origin = await serveBytes({ '/blob': bytes });
    const blobDir = await mkdtemp(path.join(os.tmpdir(), 'vmstate-blobs-'));

    const cached = await ensureBlobCached(`${origin.url}/blob`, entryFor('state.vmstate', bytes), blobDir);
    expect(cached.fetched).toBe(bytes.length);
    expect(cached.localPath).toBe(path.join(blobDir, hex(bytes)));
    expect(await readFile(cached.localPath)).toEqual(bytes);
    // no stray .partial files
    expect(readdirSync(blobDir)).toEqual([hex(bytes)]);
  });

  test('verified cache hit never touches the network', async () => {
    const bytes = Buffer.from('hit me');
    const origin = await serveBytes({ '/blob': bytes });
    const blobDir = await mkdtemp(path.join(os.tmpdir(), 'vmstate-blobs-'));
    await ensureBlobCached(`${origin.url}/blob`, entryFor('meta.json', bytes), blobDir);

    const again = await ensureBlobCached(`${origin.url}/blob`, entryFor('meta.json', bytes), blobDir);
    expect(again.fetched).toBe(0);
    expect(origin.requests.filter((r) => r === '/blob')).toHaveLength(1);
  });

  test('a corrupt cache entry is evicted and re-downloaded', async () => {
    const bytes = Buffer.from('correct bytes');
    const origin = await serveBytes({ '/blob': bytes });
    const blobDir = await mkdtemp(path.join(os.tmpdir(), 'vmstate-blobs-'));
    await writeFile(path.join(blobDir, hex(bytes)), 'corrupted');

    const cached = await ensureBlobCached(`${origin.url}/blob`, entryFor('meta.json', bytes), blobDir);
    expect(cached.fetched).toBe(bytes.length);
    expect(await readFile(cached.localPath)).toEqual(bytes);
  });

  test('a digest mismatch fails closed and caches nothing', async () => {
    const bytes = Buffer.from('expected bytes');
    const origin = await serveBytes({ '/blob': Buffer.from('tampered bytes') });
    const blobDir = await mkdtemp(path.join(os.tmpdir(), 'vmstate-blobs-'));

    await expect(
      ensureBlobCached(`${origin.url}/blob`, entryFor('state.vmstate', bytes), blobDir),
    ).rejects.toThrow(/digest mismatch.*state\.vmstate/s);
    expect(readdirSync(blobDir)).toEqual([]);
  });

  test('an unreachable origin names the URL', async () => {
    const bytes = Buffer.from('x');
    const blobDir = await mkdtemp(path.join(os.tmpdir(), 'vmstate-blobs-'));
    await expect(
      ensureBlobCached('http://127.0.0.1:1/blob', entryFor('meta.json', bytes), blobDir),
    ).rejects.toThrow(/127\.0\.0\.1:1/);
  });
});

describe('materializeVmstateDir', () => {
  async function builtFixture() {
    const { dir } = await fakeSnapshotDir();
    const built = await buildVmstateBundle(dir, { name: 'vm_machine', compatibility: COMPAT });
    // copy sources into a fake blob cache, digest-named
    const blobDir = await mkdtemp(path.join(os.tmpdir(), 'vmstate-blobs-'));
    const blobPaths: string[] = [];
    for (const [i, file] of built.manifest.files.entries()) {
      const target = path.join(blobDir, file.digest.slice('sha256:'.length));
      await writeFile(target, await readFile(built.sources[i]));
      blobPaths.push(target);
    }
    return { built, blobPaths, sourceDir: dir };
  }

  test('links/copies blobs into a complete snapshot dir', async () => {
    const { built, blobPaths, sourceDir } = await builtFixture();
    const dest = path.join(await mkdtemp(path.join(os.tmpdir(), 'vmstate-mat-')), 'snap');

    await materializeVmstateDir(built.manifest, blobPaths, dest);
    for (const file of built.manifest.files) {
      expect(await readFile(path.join(dest, file.path))).toEqual(
        await readFile(path.join(sourceDir, file.path)),
      );
    }
    // no temp dirs left behind
    expect(readdirSync(path.dirname(dest)).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  test('an already-materialized dir is reused untouched', async () => {
    const { built, blobPaths } = await builtFixture();
    const dest = path.join(await mkdtemp(path.join(os.tmpdir(), 'vmstate-mat-')), 'snap');
    await materializeVmstateDir(built.manifest, blobPaths, dest);
    const marker = path.join(dest, 'made-by-first-call');
    await writeFile(marker, 'untouched');

    await materializeVmstateDir(built.manifest, blobPaths, dest);
    expect(existsSync(marker)).toBe(true);
  });

  test('a half-built destination (wrong sizes) is rebuilt', async () => {
    const { built, blobPaths } = await builtFixture();
    const dest = path.join(await mkdtemp(path.join(os.tmpdir(), 'vmstate-mat-')), 'snap');
    await materializeVmstateDir(built.manifest, blobPaths, dest);
    await rm(path.join(dest, 'state.vmstate'));

    await materializeVmstateDir(built.manifest, blobPaths, dest);
    expect(existsSync(path.join(dest, 'state.vmstate'))).toBe(true);
  });
});
