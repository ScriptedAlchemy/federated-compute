// packages/runtime-plugin/test/vmstate-resolver.test.ts
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { resolvePullEntry } from '../src/artifacts.js';
import { isMachinenSnapshotDir } from '../src/drivers/machinen.js';
import { parseMachineEntry } from '../src/types.js';
import { VMSTATE_FORMAT, ociHostPlatform, type VmstateCompatibility } from '../src/vmstate.js';

function hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const FILES: Record<string, Buffer> = {
  'meta.json': Buffer.from('{"machinen":"meta"}'),
  'state.vmstate': Buffer.from('vm-ram-'.repeat(2000)),
  'federated-machine.json': Buffer.from(
    JSON.stringify({ remoteName: 'vm_origin', guestPort: 3801, image: 'base.tar.gz', snappedAt: 'now' }),
  ),
};

const HOST_RUNTIME = '0.4.0';

function makeBundle(compat: Partial<VmstateCompatibility> = {}) {
  const files = Object.entries(FILES).map(([filePath, bytes]) => ({
    path: filePath,
    href: `blobs/sha256/${hex(bytes)}`,
    digest: `sha256:${hex(bytes)}`,
    bytes: bytes.length,
  }));
  const manifest = {
    format: VMSTATE_FORMAT,
    name: 'vm_origin',
    createdAt: new Date().toISOString(),
    compatibility: {
      platform: ociHostPlatform(),
      machinenRuntime: HOST_RUNTIME,
      vmstateFormat: VMSTATE_FORMAT,
      snapshotEngine: 'machinen-default',
      reseed: 'machinen-0.4.0-shim@1',
      ...compat,
    },
    files,
  };
  const json = JSON.stringify(manifest);
  return { json, digest: `sha256:${hex(json)}` };
}

interface StubOrigin {
  url: string;
  requests: string[];
  close(): Promise<void>;
}

const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.all(closers.map((close) => close()));
});

/** A vmstate origin: machine manifest + bundle.json + blobs, with a request log. */
async function startVmstateOrigin(
  bundle: { json: string; digest: string },
  opts: { blobs?: Record<string, Buffer>; descriptorPlatform?: string } = {},
): Promise<StubOrigin> {
  const requests: string[] = [];
  const blobs = opts.blobs ?? FILES;
  const manifest = {
    name: 'vm_origin',
    protocol: 3,
    version: '1.0.0',
    artifacts: {
      vmstate: {
        href: `vmstate/${bundle.digest.replace(':', '-')}/bundle.json`,
        format: VMSTATE_FORMAT,
        digest: bundle.digest,
        bytes: Object.values(blobs).reduce((sum, b) => sum + b.length, 0),
        platform: opts.descriptorPlatform ?? ociHostPlatform(),
      },
    },
    exposes: { './counter': { increment: { params: [], returns: 'number' } } },
  };
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    requests.push(url);
    if (url === '/mf-manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(manifest));
      return;
    }
    if (url === `/vmstate/${bundle.digest.replace(':', '-')}/bundle.json`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(bundle.json);
      return;
    }
    const blobMatch = /^\/blobs\/sha256\/([a-f0-9]{64})$/.exec(url);
    if (blobMatch) {
      // Serve by ADVERTISED digest (the URLs the bundle names) so a tampered
      // `blobs` override answers the original URL with different bytes.
      const name = Object.entries(FILES).find(([, bytes]) => hex(bytes) === blobMatch[1])?.[0];
      const body = name ? blobs[name] : undefined;
      if (body) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(body);
        return;
      }
    }
    res.writeHead(404);
    res.end();
  });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
  );
  const origin = {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  closers.push(origin.close);
  return origin;
}

let cacheDir: string;
beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(os.tmpdir(), 'vmstate-cache-'));
});

function pullSpec(url: string, query = '?artifact=vmstate') {
  return parseMachineEntry('vm_origin', `machinen+pull+${url}${query}`);
}

const RESOLVE = { machinenRuntimeVersion: HOST_RUNTIME };

describe('resolvePullEntry: vmstate artifacts', () => {
  test('downloads blobs, materializes a snapshot dir, and rewrites the spec for restore', async () => {
    const bundle = makeBundle();
    const origin = await startVmstateOrigin(bundle);

    const resolution = await resolvePullEntry(pullSpec(origin.url), { cacheDir, ...RESOLVE });

    expect(resolution.artifact).toBe('vmstate');
    expect(resolution.localPath).toBe(
      path.join(cacheDir, 'vmstate', bundle.digest.replace(':', '-')),
    );
    expect(await isMachinenSnapshotDir(resolution.localPath)).toBe(true);
    for (const [name, bytes] of Object.entries(FILES)) {
      expect(await readFile(path.join(resolution.localPath, name))).toEqual(bytes);
    }
    expect(resolution.spec.kind).toBe('image');
    expect(resolution.spec.image).toBe(resolution.localPath);
    expect(resolution.spec.pulledFrom).toContain('machinen+pull+');
    expect(resolution.bytesFetched).toBe(
      Object.values(FILES).reduce((sum, b) => sum + b.length, 0),
    );
    expect(resolution.fromCache).toBe(false);
  });

  test('a second pull is a full cache hit: no blob downloads', async () => {
    const bundle = makeBundle();
    const origin = await startVmstateOrigin(bundle);
    await resolvePullEntry(pullSpec(origin.url), { cacheDir, ...RESOLVE });

    const second = await resolvePullEntry(pullSpec(origin.url), { cacheDir, ...RESOLVE });
    expect(second.fromCache).toBe(true);
    expect(second.bytesFetched).toBe(0);
    expect(origin.requests.filter((r) => r.startsWith('/blobs/'))).toHaveLength(
      Object.keys(FILES).length,
    );
  });

  test('cross-platform bundles are rejected at the descriptor, before even bundle.json', async () => {
    const bundle = makeBundle();
    const origin = await startVmstateOrigin(bundle, { descriptorPlatform: 'linux/never-arch' });

    await expect(
      resolvePullEntry(pullSpec(origin.url), { cacheDir, ...RESOLVE }),
    ).rejects.toThrow(/requires "linux\/never-arch"/);
    expect(origin.requests).toEqual(['/mf-manifest.json']);
  });

  test('a bundle-level platform mismatch is rejected before any blob moves', async () => {
    // Descriptor lies "compatible"; the authoritative bundle says otherwise.
    const bundle = makeBundle({ platform: 'linux/never-arch' });
    const origin = await startVmstateOrigin(bundle);

    await expect(
      resolvePullEntry(pullSpec(origin.url), { cacheDir, ...RESOLVE }),
    ).rejects.toThrow(/requires "linux\/never-arch"/);
    expect(origin.requests.filter((r) => r.startsWith('/blobs/'))).toHaveLength(0);
  });

  test('a machinen runtime mismatch names both versions and downloads nothing', async () => {
    const bundle = makeBundle({ machinenRuntime: '0.5.1' });
    const origin = await startVmstateOrigin(bundle);

    await expect(
      resolvePullEntry(pullSpec(origin.url), { cacheDir, ...RESOLVE }),
    ).rejects.toThrow(/requires @machinen\/runtime 0\.5\.1.*installed 0\.4\.0/s);
    expect(origin.requests.filter((r) => r.startsWith('/blobs/'))).toHaveLength(0);
  });

  test('a tampered bundle manifest (digest mismatch) fails closed', async () => {
    const bundle = makeBundle();
    const lying = { json: `${bundle.json} `, digest: bundle.digest }; // bytes differ from digest
    const origin = await startVmstateOrigin(lying);

    await expect(
      resolvePullEntry(pullSpec(origin.url), { cacheDir, ...RESOLVE }),
    ).rejects.toThrow(/bundle manifest digest mismatch/);
  });

  test('a tampered blob fails closed and caches nothing under its name', async () => {
    const bundle = makeBundle();
    const tampered = { ...FILES, 'state.vmstate': Buffer.from('not the advertised bytes') };
    const origin = await startVmstateOrigin(bundle, { blobs: tampered });

    await expect(
      resolvePullEntry(pullSpec(origin.url), { cacheDir, ...RESOLVE }),
    ).rejects.toThrow(/digest mismatch/);
    const blobDir = path.join(cacheDir, 'blobs', 'sha256');
    expect(
      existsSync(path.join(blobDir, hex(FILES['state.vmstate']))),
    ).toBe(false);
    // the materialized dir must not exist either
    expect(existsSync(path.join(cacheDir, 'vmstate', bundle.digest.replace(':', '-')))).toBe(false);
  });

  test('?digest= pins the bundle digest', async () => {
    const bundle = makeBundle();
    const origin = await startVmstateOrigin(bundle);
    const wrong = `sha256:${'b'.repeat(64)}`;

    await expect(
      resolvePullEntry(pullSpec(origin.url, `?artifact=vmstate&digest=${wrong}`), {
        cacheDir,
        ...RESOLVE,
      }),
    ).rejects.toThrow(/pins digest/);

    const pinned = await resolvePullEntry(
      pullSpec(origin.url, `?artifact=vmstate&digest=${bundle.digest}`),
      { cacheDir, ...RESOLVE },
    );
    expect(pinned.artifact).toBe('vmstate');
  });

  test('?version= is negotiated against the origin manifest before the bundle fetch', async () => {
    const bundle = makeBundle();
    const origin = await startVmstateOrigin(bundle);

    await expect(
      resolvePullEntry(pullSpec(origin.url, '?artifact=vmstate&version=^2.0.0'), {
        cacheDir,
        ...RESOLVE,
      }),
    ).rejects.toThrow(/version/i);
    expect(origin.requests).toEqual(['/mf-manifest.json']);
  });

  test('machines without a vmstate artifact name the gap and suggest attaching', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'bare', protocol: 3, version: '1.0.0', exposes: {} }));
    });
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
    );
    closers.push(() => new Promise((r) => server.close(() => r())));

    await expect(
      resolvePullEntry(pullSpec(`http://127.0.0.1:${port}`), { cacheDir, ...RESOLVE }),
    ).rejects.toThrow(/publishes no "vmstate" artifact.*attach/s);
  });
});
