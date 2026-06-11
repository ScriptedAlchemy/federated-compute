import { createHash } from 'node:crypto';
import { mkdtemp, readdir } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { createInstance } from '@module-federation/runtime';
import { resolvePullEntry } from '../src/artifacts.js';
import { httpAttachDriver } from '../src/drivers/http.js';
import { machinenPlugin } from '../src/plugin.js';
import { parseMachineEntry, type MachineExposeManifest } from '../src/types.js';

/**
 * Deferred review finding: artifact fetches had no timeout anywhere, so a
 * hung origin held pull resolution (and the plugin's boot memo) forever.
 * Header/small fetches get a flat deadline; streaming bodies get a
 * per-chunk idle timeout so stalls are bounded WITHOUT capping the total
 * transfer time of GB-scale artifacts.
 */

const IMAGE_BYTES = Buffer.from('// the pulled guest program\nexport const ok = true;\n');
const IMAGE_DIGEST = `sha256:${createHash('sha256').update(IMAGE_BYTES).digest('hex')}`;

const imageDescriptor = {
  href: '/mf-image',
  format: 'guest-bundle',
  digest: IMAGE_DIGEST,
  ext: '.mjs',
  bytes: IMAGE_BYTES.length,
  platform: 'any',
};

const servers: http.Server[] = [];
afterAll(async () => {
  for (const server of servers) server.close();
});

function listen(server: http.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
  );
}

async function startOrigin(
  manifest: Partial<MachineExposeManifest>,
  routes: Record<string, (res: http.ServerResponse) => void> = {},
): Promise<{ url: string }> {
  const full = {
    name: 'stub_machine',
    protocol: 3,
    version: '1.0.0',
    exposes: { './counter': { current: { params: [], returns: 'number' } } },
    ...manifest,
  } as MachineExposeManifest;
  const server = http.createServer((req, res) => {
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
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}` };
}

async function until(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

let cacheDir: string;
beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(os.tmpdir(), 'mf-timeout-'));
});

function pullSpec(url: string, query = '') {
  return parseMachineEntry('stub_machine', `machinen+pull+${url}${query}`);
}

describe('header/small fetch timeouts', () => {
  test('an origin that accepts the socket but never sends headers fails with a clear timeout error', async () => {
    // The handler never responds: the connection is open, headers never come.
    const server = http.createServer(() => {});
    const port = await listen(server);

    const error = (await resolvePullEntry(pullSpec(`http://127.0.0.1:${port}`), {
      cacheDir,
      fetchTimeoutMs: 100,
    }).catch((e: unknown) => e)) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/timed out after 100ms/);
    expect(error.message).toContain('stub_machine');
  });

  test('an image artifact endpoint whose headers never arrive times out', async () => {
    const origin = await startOrigin(
      { artifacts: { image: imageDescriptor } },
      { '/mf-image': () => {} }, // accept the request, answer nothing
    );

    const error = (await resolvePullEntry(pullSpec(origin.url), {
      cacheDir,
      fetchTimeoutMs: 100,
    }).catch((e: unknown) => e)) as Error;

    expect(error.message).toMatch(/image artifact .* timed out after 100ms/);
    expect(await readdir(cacheDir)).toEqual([]);
  });

  test('a snapshot body that stalls after headers is bounded by the fetch timeout', async () => {
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
          res.write('{"name":"stub_machine","imageDig'); // half the JSON, then silence
        },
      },
    );

    const error = (await resolvePullEntry(pullSpec(origin.url, '?artifact=snapshot'), {
      cacheDir,
      fetchTimeoutMs: 100,
    }).catch((e: unknown) => e)) as Error;

    expect(error.message).toMatch(/snapshot artifact .* timed out after 100ms/);
    expect(error.message).toContain('stub_machine');
  });
});

describe('streaming body idle timeout', () => {
  test('a body that stalls mid-stream fails, cleans the temp, and the origin sees the cancellation', async () => {
    let sawAbort = false;
    const origin = await startOrigin(
      { artifacts: { image: imageDescriptor } },
      {
        '/mf-image': (res) => {
          let finished = false;
          res.on('finish', () => {
            finished = true;
          });
          res.on('close', () => {
            if (!finished) sawAbort = true;
          });
          res.writeHead(200, { 'content-type': 'text/javascript' });
          res.write(IMAGE_BYTES.subarray(0, 10)); // half the body, then stall forever
        },
      },
    );

    const error = (await resolvePullEntry(pullSpec(origin.url), {
      cacheDir,
      streamIdleTimeoutMs: 80,
    }).catch((e: unknown) => e)) as Error;

    expect(error.message).toMatch(/idle timeout/);
    expect(error.message).toMatch(/80ms/);
    expect(error.message).toContain('stub_machine');
    // No temp litter: a later resolve starts clean.
    expect(await readdir(cacheDir)).toEqual([]);
    // The reader was cancelled, so the origin observes the aborted request.
    await until(() => sawAbort);
  });

  test('a slow but steady body is NOT capped by the fetch timeout (idle resets per chunk)', async () => {
    // 8 chunks, 30ms apart: total ~240ms exceeds BOTH the 120ms fetch
    // timeout and the 100ms idle timeout — but headers arrive fast and no
    // single gap exceeds the idle window, so the transfer must succeed.
    const chunks = Array.from({ length: 8 }, (_, i) => Buffer.from(`chunk ${i};\n`));
    const bytes = Buffer.concat(chunks);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const origin = await startOrigin(
      { artifacts: { image: { ...imageDescriptor, digest, bytes: bytes.length } } },
      {
        '/mf-image': (res) => {
          res.writeHead(200, { 'content-type': 'text/javascript' });
          let sent = 0;
          const timer = setInterval(() => {
            res.write(chunks[sent]);
            sent++;
            if (sent === chunks.length) {
              clearInterval(timer);
              res.end();
            }
          }, 30);
          res.on('close', () => clearInterval(timer));
        },
      },
    );

    const resolution = await resolvePullEntry(pullSpec(origin.url), {
      cacheDir,
      fetchTimeoutMs: 120,
      streamIdleTimeoutMs: 100,
    });

    expect(resolution.bytesFetched).toBe(bytes.length);
    expect(resolution.fromCache).toBe(false);
  });
});

describe('timeout threading from plugin options', () => {
  test('artifactFetchTimeoutMs reaches the pull resolver', async () => {
    const server = http.createServer(() => {}); // never answers
    const port = await listen(server);

    const remote = { name: 'hung_machine', entry: `machinen+pull+http://127.0.0.1:${port}` };
    const plugin = machinenPlugin({
      driver: httpAttachDriver(),
      artifactFetchTimeoutMs: 100,
    });
    const host = createInstance({ name: 'host_hung', remotes: [remote], plugins: [plugin] });

    const error = (await host
      .loadRemote(`${remote.name}/svc`)
      .catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/timed out after 100ms/);
  });
});
