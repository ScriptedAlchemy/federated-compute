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

function serveImageChunks(res: http.ServerResponse, chunks: Buffer[]): void {
  res.writeHead(200, { 'content-type': 'text/javascript' });
  for (const chunk of chunks.slice(0, -1)) res.write(chunk);
  setImmediate(() => res.end(chunks.at(-1)));
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

  test('streams a multi-chunk image body through digest verification', async () => {
    const chunks = [
      Buffer.from('// streamed image part 1\n'),
      Buffer.from('export const streamed = '),
      Buffer.from('true;\n'),
    ];
    const bytes = Buffer.concat(chunks);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const origin = await startOrigin(
      { artifacts: { image: { ...imageDescriptor, digest, bytes: bytes.length } } },
      { '/mf-image': (res) => serveImageChunks(res, chunks) },
    );
    const arrayBuffer = Response.prototype.arrayBuffer;
    Response.prototype.arrayBuffer = async () => {
      throw new Error('image download must stream instead of buffering with arrayBuffer');
    };
    try {
      const resolution = await resolvePullEntry(pullSpec(origin.url), { cacheDir });

      expect(resolution.fromCache).toBe(false);
      expect(resolution.bytesFetched).toBe(bytes.length);
      expect(await readFile(resolution.localPath)).toEqual(bytes);
    } finally {
      Response.prototype.arrayBuffer = arrayBuffer;
    }
  });

  test('verifies a multi-chunk cached image as a hit without contacting the origin', async () => {
    // The verify path streams (createReadStream + incremental hash) so the
    // cache keeps working at >=2GiB, where readFile would throw
    // ERR_FS_FILE_TOO_LARGE and silently turn every hit into a re-download.
    // A cached artifact spanning many read chunks must verify as a pure hit.
    const big = Buffer.concat([
      IMAGE_BYTES,
      Buffer.from('\n// padding\n'.repeat(40_000)), // ~480KB: many 64KB stream chunks
    ]);
    const digest = `sha256:${createHash('sha256').update(big).digest('hex')}`;
    const origin = await startOrigin({
      artifacts: { image: { ...imageDescriptor, digest, bytes: big.length } },
    });
    const cachePath = path.join(cacheDir, `${digest.slice('sha256:'.length)}.mjs`);
    await writeFile(cachePath, big);

    const resolution = await resolvePullEntry(pullSpec(origin.url), { cacheDir });

    expect(resolution.fromCache).toBe(true);
    expect(resolution.bytesFetched).toBe(0);
    expect(origin.requests).not.toContain('/mf-image');
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

  test('a digest pin on a snapshot pull is honored when it matches the referenced image', async () => {
    const origin = await snapshotOrigin({ counter: 5 });

    const resolution = await resolvePullEntry(
      pullSpec(origin.url, `?artifact=snapshot&digest=${IMAGE_DIGEST}`),
      { cacheDir },
    );

    const bundle = JSON.parse(await readFile(resolution.localPath, 'utf8'));
    expect(bundle.state).toEqual({ counter: 5 });
    expect(await readFile(bundle.image)).toEqual(IMAGE_BYTES);
  });

  test('a digest pin mismatching the snapshot image fails before any image bytes move', async () => {
    const origin = await snapshotOrigin();
    const pinned = `sha256:${'c'.repeat(64)}`;

    await expect(
      resolvePullEntry(pullSpec(origin.url, `?artifact=snapshot&digest=${pinned}`), { cacheDir }),
    ).rejects.toThrow(/pins digest .* but the pulled snapshot references image digest/i);
    // The reference check fails before the image download and before any
    // bundle is materialized.
    expect(origin.requests.filter((r) => r === '/mf-image')).toHaveLength(0);
    expect(await readdir(cacheDir)).toEqual([]);
  });

  test('a null snapshot body fails with a machine-named error, not a bare TypeError', async () => {
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
          res.end('null');
        },
      },
    );

    const error = await resolvePullEntry(pullSpec(origin.url, '?artifact=snapshot'), {
      cacheDir,
    }).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/snapshot artifact .* is not a JSON object/);
    expect((error as Error).message).toContain('stub_machine');
  });

  test('non-object snapshot bodies (string, array) fail the same machine-named way', async () => {
    for (const body of ['"warm"', '[1,2,3]', '42']) {
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
            res.end(body);
          },
        },
      );
      await expect(
        resolvePullEntry(pullSpec(origin.url, '?artifact=snapshot'), { cacheDir }),
      ).rejects.toThrow(/is not a JSON object/);
    }
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

describe('resolvePullEntry: adversarial origins (integrity)', () => {
  test('an artifact endpoint answering HTML fails the digest check and caches nothing', async () => {
    const origin = await startOrigin(
      { artifacts: { image: imageDescriptor } },
      {
        '/mf-image': (res) => {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<html><body>Sign in to your captive portal</body></html>');
        },
      },
    );

    await expect(resolvePullEntry(pullSpec(origin.url), { cacheDir })).rejects.toThrow(
      /digest mismatch/i,
    );
    expect(await readdir(cacheDir)).toEqual([]);
  });

  test('a snapshot endpoint answering HTML fails as not-JSON, never a crash', async () => {
    const origin = await startOrigin(
      {
        artifacts: {
          image: imageDescriptor,
          snapshot: { href: '/mf-snapshot', format: 'app-state@1' },
        },
      },
      {
        '/mf-snapshot': (res) => {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<!doctype html><h1>502 Bad Gateway</h1>');
        },
      },
    );

    await expect(
      resolvePullEntry(pullSpec(origin.url, '?artifact=snapshot'), { cacheDir }),
    ).rejects.toThrow(/is not valid JSON/);
  });

  test('a truncated download fails the digest and leaves nothing cached or bootable', async () => {
    const origin = await startOrigin(
      { artifacts: { image: imageDescriptor } },
      {
        // A "complete" response carrying only a prefix of the artifact —
        // what a cut connection or buggy proxy hands back.
        '/mf-image': (res) => serveImage(res, IMAGE_BYTES.subarray(0, 10)),
      },
    );

    await expect(resolvePullEntry(pullSpec(origin.url), { cacheDir })).rejects.toThrow(
      /digest mismatch/i,
    );
    // No cached artifact, no temp file litter: a later resolve must re-fetch.
    expect(await readdir(cacheDir)).toEqual([]);
  });

  test('after a truncated download, a healthy origin resolves cleanly on retry', async () => {
    let truncate = true;
    const origin = await startOrigin(
      { artifacts: { image: imageDescriptor } },
      {
        '/mf-image': (res) => serveImage(res, truncate ? IMAGE_BYTES.subarray(0, 10) : IMAGE_BYTES),
      },
    );

    await expect(resolvePullEntry(pullSpec(origin.url), { cacheDir })).rejects.toThrow();
    truncate = false;
    const resolution = await resolvePullEntry(pullSpec(origin.url), { cacheDir });
    expect(await readFile(resolution.localPath)).toEqual(IMAGE_BYTES);
  });

  test('two concurrent fetches of one digest never tear the cache — both callers win', async () => {
    const origin = await startOrigin(
      { artifacts: { image: imageDescriptor } },
      {
        // Delay the body so both pulls overlap mid-download.
        '/mf-image': (res) => {
          setTimeout(() => serveImage(res), 50);
        },
      },
    );

    const [a, b] = await Promise.all([
      resolvePullEntry(pullSpec(origin.url), { cacheDir }),
      resolvePullEntry(pullSpec(origin.url), { cacheDir }),
    ]);

    expect(a.localPath).toBe(b.localPath);
    expect(await readFile(a.localPath)).toEqual(IMAGE_BYTES);
    // Exactly one cache entry, zero temp-file litter.
    expect(await readdir(cacheDir)).toEqual([path.basename(a.localPath)]);
    // Both raced the miss: two downloads is acceptable, a torn file is not.
    expect(origin.requests.filter((r) => r === '/mf-image')).toHaveLength(2);
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
