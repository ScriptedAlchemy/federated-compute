// packages/runtime-plugin/test/publish.test.ts
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { publishSnapshotDir, startArtifactEndpoint, type ArtifactEndpoint } from '../src/publish.js';
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
const SHELL = {
  rootfsDigest: `sha256:${'1'.repeat(64)}`,
  kernelDigest: `sha256:${'2'.repeat(64)}`,
};

async function fakeSnapshotDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'publish-snap-'));
  for (const [name, bytes] of Object.entries(FILES)) {
    await writeFile(path.join(dir, name), bytes);
  }
  return dir;
}

describe('publishSnapshotDir', () => {
  test('rejects machine names that are not one safe path segment', async () => {
    const layoutDir = await mkdtemp(path.join(os.tmpdir(), 'publish-layout-'));
    await expect(
      publishSnapshotDir({
        snapDir: await fakeSnapshotDir(),
        name: '../escape',
        manifest: GUEST_MANIFEST,
        layoutDir,
        compatibility: { shell: SHELL },
      }),
    ).rejects.toThrow(/machine name.*invalid/i);
  });

  test('writes blobs, bundle.json, and a vmstate-only mf-manifest.json into the layout', async () => {
    const snapDir = await fakeSnapshotDir();
    const layoutDir = await mkdtemp(path.join(os.tmpdir(), 'publish-layout-'));

    const published = await publishSnapshotDir({
      snapDir,
      name: 'vm_machine',
      manifest: GUEST_MANIFEST,
      layoutDir,
      compatibility: { shell: SHELL },
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

  test('published digest-addressed blobs do not follow later source mutations', async () => {
    const snapDir = await fakeSnapshotDir();
    const layoutDir = await mkdtemp(path.join(os.tmpdir(), 'publish-layout-'));
    const published = await publishSnapshotDir({
      snapDir,
      name: 'vm_machine',
      manifest: GUEST_MANIFEST,
      layoutDir,
      compatibility: { shell: SHELL },
    });

    await writeFile(path.join(snapDir, 'state.vmstate'), Buffer.from('mutated'));

    const blobPath = path.join(
      published.machineDir,
      'blobs',
      'sha256',
      hex(FILES['state.vmstate']),
    );
    expect(await readFile(blobPath)).toEqual(FILES['state.vmstate']);
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
      compatibility: { shell: SHELL },
    });
    const second = await publishSnapshotDir({
      snapDir,
      name: 'vm_machine',
      manifest: GUEST_MANIFEST,
      layoutDir,
      compatibility: { shell: SHELL },
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
      compatibility: { platform: 'linux/never-arch', machinenRuntime: '9.9.9', shell: SHELL },
    });
    const bundle = parseVmstateBundleManifest(
      await readFile(published.bundlePath, 'utf8'),
      'at published bundle',
    );
    expect(bundle.compatibility.platform).toBe('linux/never-arch');
    expect(bundle.compatibility.machinenRuntime).toBe('9.9.9');
    expect(published.descriptor.platform).toBe('linux/never-arch');
  });

  test('rejects malformed shell compatibility', async () => {
    await expect(
      publishSnapshotDir({
        snapDir: await fakeSnapshotDir(),
        name: 'vm_machine',
        manifest: GUEST_MANIFEST,
        layoutDir: await mkdtemp(path.join(os.tmpdir(), 'publish-layout-')),
        compatibility: {
          shell: {
            rootfsDigest: 'not-a-digest',
            kernelDigest: SHELL.kernelDigest,
          } as unknown as typeof SHELL,
        },
      }),
    ).rejects.toThrow(/compatibility\.shell.*sha256/i);
  });
});

const endpoints: ArtifactEndpoint[] = [];
afterAll(async () => {
  await Promise.all(endpoints.map((e) => e.close()));
});

describe('startArtifactEndpoint', () => {
  async function publishedLayout(extraMachine?: string) {
    const layoutDir = await mkdtemp(path.join(os.tmpdir(), 'endpoint-layout-'));
    const published = await publishSnapshotDir({
      snapDir: await fakeSnapshotDir(),
      name: 'vm_machine',
      manifest: GUEST_MANIFEST,
      layoutDir,
      compatibility: { shell: SHELL },
    });
    if (extraMachine) {
      await publishSnapshotDir({
        snapDir: await fakeSnapshotDir(),
        name: extraMachine,
        manifest: { ...GUEST_MANIFEST, name: extraMachine },
        layoutDir,
        compatibility: { shell: SHELL },
      });
    }
    const endpoint = await startArtifactEndpoint({ layoutDir });
    endpoints.push(endpoint);
    return { endpoint, published };
  }

  test('serves manifest, bundle, and blobs under /machines/<name>', async () => {
    const { endpoint, published } = await publishedLayout();
    const base = `${endpoint.url}/machines/vm_machine`;

    const manifest = (await (await fetch(`${base}/mf-manifest.json`)).json()) as MachineExposeManifest;
    expect(manifest.artifacts?.vmstate?.digest).toBe(published.digest);

    const bundleRes = await fetch(`${base}/${published.descriptor.href}`);
    expect(bundleRes.status).toBe(200);
    expect(`sha256:${hex(Buffer.from(await bundleRes.arrayBuffer()))}`).toBe(published.digest);

    const blobHex = hex(FILES['state.vmstate']);
    const blobRes = await fetch(`${base}/blobs/sha256/${blobHex}`);
    expect(blobRes.status).toBe(200);
    expect(blobRes.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await blobRes.arrayBuffer())).toEqual(FILES['state.vmstate']);
  });

  test('honors single byte ranges on blobs', async () => {
    const { endpoint } = await publishedLayout();
    const blobHex = hex(FILES['state.vmstate']);
    const res = await fetch(
      `${endpoint.url}/machines/vm_machine/blobs/sha256/${blobHex}`,
      { headers: { range: 'bytes=0-6' } },
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(
      `bytes 0-6/${FILES['state.vmstate'].length}`,
    );
    expect(Buffer.from(await res.arrayBuffer())).toEqual(FILES['state.vmstate'].subarray(0, 7));
  });

  test('root-mounts the single published machine; stops when a second appears', async () => {
    const single = await publishedLayout();
    const rootManifest = await fetch(`${single.endpoint.url}/mf-manifest.json`);
    expect(rootManifest.status).toBe(200);

    const double = await publishedLayout('other_machine');
    expect((await fetch(`${double.endpoint.url}/mf-manifest.json`)).status).toBe(404);
    expect(
      (await fetch(`${double.endpoint.url}/machines/other_machine/mf-manifest.json`)).status,
    ).toBe(200);
  });

  test('is read-only and traversal-safe', async () => {
    const { endpoint } = await publishedLayout();
    expect(
      (await fetch(`${endpoint.url}/machines/vm_machine/mf-manifest.json`, { method: 'POST' }))
        .status,
    ).toBe(405);
    expect((await fetch(`${endpoint.url}/machines/../package.json`)).status).toBe(404);
    expect((await fetch(`${endpoint.url}/machines/vm_machine/blobs/sha256/nope`)).status).toBe(404);
  });

  test('binds loopback by default', async () => {
    const { endpoint } = await publishedLayout();
    expect(endpoint.url.startsWith('http://127.0.0.1:')).toBe(true);
  });
});
