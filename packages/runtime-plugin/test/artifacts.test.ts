import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { resolvePullEntry } from '../src/artifacts.js';
import { MachineVersionError } from '../src/errors.js';
import { createGuestRuntime, serveGuest, type GuestServer } from '../src/guest.js';
import { parseMachineEntry, type MachineExposeManifest } from '../src/types.js';

const IMAGE_BYTES = Buffer.from('// the pulled guest program\nexport const ok = true;\n');
const IMAGE_DIGEST = `sha256:${createHash('sha256').update(IMAGE_BYTES).digest('hex')}`;

interface StubOrigin {
  port: number;
  url: string;
  /** Paths requested, in order. */
  requests: string[];
  close(): Promise<void>;
}

const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.all(closers.map((close) => close()));
});

/** A controllable machine origin: serves a manifest plus arbitrary routes. */
async function startOrigin(
  manifest: Partial<MachineExposeManifest>,
  routes: Record<string, (res: http.ServerResponse) => void> = {},
): Promise<StubOrigin> {
  const requests: string[] = [];
  const full: MachineExposeManifest = {
    name: 'stub_machine',
    protocol: 3,
    version: '1.0.0',
    exposes: { './counter': { current: { params: [], returns: 'number' } } },
    ...manifest,
  } as MachineExposeManifest;
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url === '/mf-manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(full));
      return;
    }
    const route = routes[req.url ?? ''];
    if (route) {
      route(res);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
  );
  const origin = {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  closers.push(origin.close);
  return origin;
}

function serveImage(res: http.ServerResponse, bytes: Buffer = IMAGE_BYTES): void {
  res.writeHead(200, { 'content-type': 'text/javascript' });
  res.end(bytes);
}

const imageDescriptor = {
  href: '/mf-image',
  format: 'guest-bundle',
  digest: IMAGE_DIGEST,
  ext: '.mjs',
  bytes: IMAGE_BYTES.length,
  platform: 'any',
};

let cacheDir: string;
beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(os.tmpdir(), 'mf-cache-'));
});

function pullSpec(url: string, query = '') {
  return parseMachineEntry('stub_machine', `machinen+pull+${url}${query}`);
}

describe('resolvePullEntry: image artifacts', () => {
  test('downloads the image into the digest cache and rewrites the spec for local boot', async () => {
    const origin = await startOrigin(
      { artifacts: { image: imageDescriptor } },
      { '/mf-image': (res) => serveImage(res) },
    );

    const resolution = await resolvePullEntry(pullSpec(origin.url, '?version=^1.0.0'), { cacheDir });

    expect(resolution.artifact).toBe('image');
    expect(resolution.fromCache).toBe(false);
    expect(resolution.bytesFetched).toBe(IMAGE_BYTES.length);
    // Cached under its digest, keeping the bootable extension.
    expect(resolution.localPath).toBe(
      path.join(cacheDir, `${IMAGE_DIGEST.slice('sha256:'.length)}.mjs`),
    );
    expect(await readFile(resolution.localPath)).toEqual(IMAGE_BYTES);

    const { spec } = resolution;
    expect(spec.kind).toBe('image');
    expect(spec.image).toBe(resolution.localPath);
    expect(spec.pulledFrom).toContain(`machinen+pull+${origin.url}`);
    // Version pin survives so the booted clone is validated too.
    expect(spec.params.get('version')).toBe('^1.0.0');
  });

  test('cache hit: the artifact is not re-downloaded', async () => {
    const origin = await startOrigin(
      { artifacts: { image: imageDescriptor } },
      { '/mf-image': (res) => serveImage(res) },
    );

    await resolvePullEntry(pullSpec(origin.url), { cacheDir });
    const second = await resolvePullEntry(pullSpec(origin.url), { cacheDir });

    expect(second.fromCache).toBe(true);
    expect(second.bytesFetched).toBe(0);
    expect(origin.requests.filter((r) => r === '/mf-image')).toHaveLength(1);
  });

  test('a corrupt cache entry is evicted and re-downloaded', async () => {
    const origin = await startOrigin(
      { artifacts: { image: imageDescriptor } },
      { '/mf-image': (res) => serveImage(res) },
    );
    const cachePath = path.join(cacheDir, `${IMAGE_DIGEST.slice('sha256:'.length)}.mjs`);
    await writeFile(cachePath, 'corrupted bytes that do not match the digest');

    const resolution = await resolvePullEntry(pullSpec(origin.url), { cacheDir });

    expect(resolution.fromCache).toBe(false);
    expect(await readFile(cachePath)).toEqual(IMAGE_BYTES);
  });

  test('a download whose bytes do not match the advertised digest fails and caches nothing', async () => {
    const origin = await startOrigin(
      { artifacts: { image: imageDescriptor } },
      { '/mf-image': (res) => serveImage(res, Buffer.from('tampered artifact')) },
    );

    await expect(resolvePullEntry(pullSpec(origin.url), { cacheDir })).rejects.toThrow(
      /digest mismatch/i,
    );
    expect(await readdir(cacheDir)).toEqual([]);
  });

  test('version is negotiated against the origin manifest BEFORE any artifact download', async () => {
    const origin = await startOrigin(
      { version: '1.0.0', artifacts: { image: imageDescriptor } },
      { '/mf-image': (res) => serveImage(res) },
    );

    await expect(
      resolvePullEntry(pullSpec(origin.url, '?version=^2.0.0'), { cacheDir }),
    ).rejects.toThrow(MachineVersionError);
    expect(origin.requests).toEqual(['/mf-manifest.json']);
  });

  test('refuses artifacts published for a different platform', async () => {
    const origin = await startOrigin({
      artifacts: { image: { ...imageDescriptor, platform: 'linux/never-arch' } },
    });

    await expect(resolvePullEntry(pullSpec(origin.url), { cacheDir })).rejects.toThrow(
      /platform "linux\/never-arch"/,
    );
  });

  test('a digest pin on the entry must match what the origin offers', async () => {
    const origin = await startOrigin({ artifacts: { image: imageDescriptor } });
    const pinned = `sha256:${'a'.repeat(64)}`;

    await expect(
      resolvePullEntry(pullSpec(origin.url, `?digest=${pinned}`), { cacheDir }),
    ).rejects.toThrow(/digest/i);
  });

  test('machines without an artifacts block cannot be pulled — the error suggests attaching', async () => {
    const origin = await startOrigin({});

    await expect(resolvePullEntry(pullSpec(origin.url), { cacheDir })).rejects.toThrow(
      /publishes no .*artifact.*attach/is,
    );
  });

  test('unsupported artifact formats are rejected by name', async () => {
    const origin = await startOrigin({
      artifacts: { image: { ...imageDescriptor, format: 'oci-layout@7' } },
    });

    await expect(resolvePullEntry(pullSpec(origin.url), { cacheDir })).rejects.toThrow(
      /format "oci-layout@7"/,
    );
  });

  test('a hostile ext from the origin cannot escape the cache dir', async () => {
    const origin = await startOrigin({
      artifacts: { image: { ...imageDescriptor, ext: '/../../etc/pwned' } },
    });

    await expect(resolvePullEntry(pullSpec(origin.url), { cacheDir })).rejects.toThrow(/ext/i);
  });

  test('an unreachable origin fails with the URL in the error', async () => {
    const spec = pullSpec('http://127.0.0.1:1');
    await expect(resolvePullEntry(spec, { cacheDir })).rejects.toThrow(/127\.0\.0\.1:1/);
  });
});

describe('resolvePullEntry: snapshot artifacts (fork-by-fetch)', () => {
  function snapshotOrigin(state: unknown = { counter: 3 }) {
    return startOrigin(
      {
        artifacts: {
          image: imageDescriptor,
          snapshot: { href: '/mf-snapshot', format: 'app-state@1', platform: 'any' },
        },
      },
      {
        '/mf-image': (res) => serveImage(res),
        '/mf-snapshot': (res) => {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(
            JSON.stringify({
              name: 'stub_machine',
              imageDigest: IMAGE_DIGEST,
              state,
              createdAt: new Date().toISOString(),
            }),
          );
        },
      },
    );
  }

  test('materializes a process-driver .snap bundle referencing the cached image', async () => {
    const origin = await snapshotOrigin({ counter: 7 });

    const resolution = await resolvePullEntry(pullSpec(origin.url, '?artifact=snapshot'), {
      cacheDir,
    });

    expect(resolution.artifact).toBe('snapshot');
    expect(resolution.localPath.endsWith('.snap')).toBe(true);
    expect(resolution.spec.kind).toBe('image');
    expect(resolution.spec.image).toBe(resolution.localPath);

    const bundle = JSON.parse(await readFile(resolution.localPath, 'utf8'));
    expect(bundle.name).toBe('stub_machine');
    expect(bundle.state).toEqual({ counter: 7 });
    // The bundle's image points at the digest-cached file, ready to boot.
    expect(bundle.image).toBe(path.join(cacheDir, `${IMAGE_DIGEST.slice('sha256:'.length)}.mjs`));
    expect(existsSync(bundle.image)).toBe(true);
    expect(await readFile(bundle.image)).toEqual(IMAGE_BYTES);
  });

  test('the image is only downloaded on digest miss; state is pulled fresh every time', async () => {
    const origin = await snapshotOrigin();

    const first = await resolvePullEntry(pullSpec(origin.url, '?artifact=snapshot'), { cacheDir });
    const second = await resolvePullEntry(pullSpec(origin.url, '?artifact=snapshot'), { cacheDir });

    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(origin.requests.filter((r) => r === '/mf-image')).toHaveLength(1);
    expect(origin.requests.filter((r) => r === '/mf-snapshot')).toHaveLength(2);
  });

  test('asking for a snapshot a machine does not publish names the missing artifact', async () => {
    const origin = await startOrigin({ artifacts: { image: imageDescriptor } });

    await expect(
      resolvePullEntry(pullSpec(origin.url, '?artifact=snapshot'), { cacheDir }),
    ).rejects.toThrow(/snapshot/);
  });

  test('a snapshot referencing an image the origin does not serve fails clearly', async () => {
    const otherDigest = `sha256:${'b'.repeat(64)}`;
    const origin = await startOrigin(
      {
        artifacts: {
          image: imageDescriptor,
          snapshot: { href: '/mf-snapshot', format: 'app-state@1' },
        },
      },
      {
        '/mf-snapshot': (res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              name: 'stub_machine',
              imageDigest: otherDigest,
              state: {},
              createdAt: new Date().toISOString(),
            }),
          );
        },
      },
    );

    await expect(
      resolvePullEntry(pullSpec(origin.url, '?artifact=snapshot'), { cacheDir }),
    ).rejects.toThrow(/references image digest/i);
  });
});

describe('resolvePullEntry against a real guest (both sides of the protocol agree)', () => {
  const servers: GuestServer[] = [];
  afterAll(async () => {
    await Promise.all(servers.map((s) => s.close()));
  });

  test('pulls the snapshot a live serveGuest publishes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mf-real-image-'));
    const imageFile = path.join(dir, 'real-guest.mjs');
    await writeFile(imageFile, IMAGE_BYTES);

    let counter = 41;
    const guest = createGuestRuntime({
      name: 'real_guest',
      version: '2.1.0',
      exposes: { './counter': { current: () => counter } },
      state: {
        dehydrate: () => ({ counter }),
        rehydrate: (s) => {
          counter = (s as { counter: number }).counter;
        },
      },
    });
    const server = await serveGuest(guest, { port: 0, imagePath: imageFile });
    servers.push(server);

    const spec = parseMachineEntry(
      'real_guest',
      `machinen+pull+http://127.0.0.1:${server.port}?artifact=snapshot&version=^2.0.0`,
    );
    const resolution = await resolvePullEntry(spec, { cacheDir });

    const bundle = JSON.parse(await readFile(resolution.localPath, 'utf8'));
    expect(bundle.state).toEqual({ counter: 41 });
    expect(await readFile(bundle.image)).toEqual(IMAGE_BYTES);
  });
});
