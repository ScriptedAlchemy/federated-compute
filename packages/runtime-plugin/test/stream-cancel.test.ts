import { createHash } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Deferred review finding: neither download cancel path had coverage —
 * (a) a temp-file open failure must cancel the unconsumed response body,
 * (b) a write failure mid-stream (ENOSPC at GB scale) must cancel the
 * reader so the socket and the remaining transfer die with the request.
 * Both are observed from the origin's side: the response closes without
 * ever finishing.
 *
 * Isolated in its own file because it mocks node:fs/promises (importActual
 * passthrough, with only `open` overridable per test).
 */

const hoisted = vi.hoisted(() => ({
  openImpl: undefined as undefined | ((...args: unknown[]) => Promise<unknown>),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) =>
      hoisted.openImpl ? hoisted.openImpl(...args) : actual.open(...args),
  };
});

import { mkdtemp, readdir } from 'node:fs/promises';
import { resolvePullEntry } from '../src/artifacts.js';
import { parseMachineEntry, type MachineExposeManifest } from '../src/types.js';

const IMAGE_DIGEST = `sha256:${'d'.repeat(64)}`; // never reached: both tests fail before the digest check

const imageDescriptor = {
  href: '/mf-image',
  format: 'guest-bundle',
  digest: IMAGE_DIGEST,
  ext: '.mjs',
  bytes: 1024,
  platform: 'any',
};

interface AbortObserver {
  url: string;
  sawAbort: () => boolean;
}

const servers: http.Server[] = [];
afterAll(async () => {
  for (const server of servers) server.close();
});

/**
 * An origin whose /mf-image streams chunks forever and never finishes: the
 * only way its response ends is the consumer aborting the request, which we
 * record as 'close' without 'finish'.
 */
async function startStreamingOrigin(): Promise<AbortObserver> {
  let aborted = false;
  const manifest = {
    name: 'stub_machine',
    protocol: 3,
    version: '1.0.0',
    exposes: { './counter': { current: { params: [], returns: 'number' } } },
    artifacts: { image: imageDescriptor },
  } as unknown as MachineExposeManifest;
  const server = http.createServer((req, res) => {
    if (req.url === '/mf-manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(manifest));
      return;
    }
    if (req.url === '/mf-image') {
      let finished = false;
      res.on('finish', () => {
        finished = true;
      });
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.write(Buffer.from('// chunk 0\n'));
      const timer = setInterval(() => res.write(Buffer.from('// more bytes\n')), 15);
      res.on('close', () => {
        clearInterval(timer);
        if (!finished) aborted = true;
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
  );
  return { url: `http://127.0.0.1:${port}`, sawAbort: () => aborted };
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
  cacheDir = await mkdtemp(path.join(os.tmpdir(), 'mf-cancel-'));
});

afterEach(() => {
  hoisted.openImpl = undefined;
});

function pullSpec(url: string) {
  return parseMachineEntry('stub_machine', `machinen+pull+${url}`);
}

describe('download cancel paths', () => {
  test('a temp-file open failure cancels the unconsumed body — the origin sees the abort', async () => {
    const origin = await startStreamingOrigin();
    hoisted.openImpl = async () => {
      throw new Error('EACCES: open failed (mock)');
    };

    const error = (await resolvePullEntry(pullSpec(origin.url), { cacheDir }).catch(
      (e: unknown) => e,
    )) as Error;

    expect(error.message).toMatch(/open failed \(mock\)/);
    // res.body.cancel() aborted the request: close without finish.
    await until(() => origin.sawAbort());
    // Nothing was ever written: no temp litter.
    expect(await readdir(cacheDir)).toEqual([]);
  });

  test('a write failure mid-stream cancels the reader, removes the temp, and propagates', async () => {
    const origin = await startStreamingOrigin();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let writes = 0;
    hoisted.openImpl = async (...args: unknown[]) => {
      const real = await actual.open(...(args as Parameters<typeof actual.open>));
      // A handle whose second write rejects — the temp file genuinely
      // exists on disk with the first chunk, so cleanup is observable.
      return {
        write: async (chunk: Uint8Array) => {
          writes++;
          if (writes > 1) throw new Error('ENOSPC: no space left on device (mock)');
          return real.write(chunk);
        },
        close: () => real.close(),
      };
    };

    const error = (await resolvePullEntry(pullSpec(origin.url), { cacheDir }).catch(
      (e: unknown) => e,
    )) as Error;

    // The write error propagates unchanged...
    expect(error.message).toMatch(/ENOSPC: no space left on device \(mock\)/);
    expect(writes).toBe(2);
    // ...reader.cancel() killed the request from the origin's perspective...
    await until(() => origin.sawAbort());
    // ...and the partially written temp file was removed.
    expect(await readdir(cacheDir)).toEqual([]);
  });
});
