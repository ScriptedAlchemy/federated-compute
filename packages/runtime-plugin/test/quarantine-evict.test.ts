import { createHash } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Deferred review finding: evicting a corrupt cache entry with a plain
 * rm-by-path races concurrent committers — between our hash mismatch and
 * our rm, a sibling process can rename a freshly verified file onto the
 * same path, and the rm then deletes GOOD bytes (TOCTOU). The fix renames
 * the corrupt file to a unique quarantine name first and deletes THAT; the
 * delete never operates on a path a committer will rename onto.
 *
 * The fs mock below only OBSERVES rename/rm (delegating to the real fs) so
 * the eviction protocol itself can be asserted, not just the end state.
 */

const hoisted = vi.hoisted(() => ({
  renameCalls: [] as { from: string; to: string }[],
  rmCalls: [] as string[],
  failQuarantineRename: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      hoisted.renameCalls.push({ from: String(from), to: String(to) });
      if (hoisted.failQuarantineRename && String(to).includes('.evict-')) {
        throw new Error('EXDEV: cross-device link not permitted (mock)');
      }
      return actual.rename(from, to);
    },
    rm: async (target: string, opts?: Parameters<typeof actual.rm>[1]) => {
      hoisted.rmCalls.push(String(target));
      return actual.rm(target, opts);
    },
  };
});

import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolvePullEntry } from '../src/artifacts.js';
import { parseMachineEntry, type MachineExposeManifest } from '../src/types.js';

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

async function startOrigin(): Promise<{ url: string }> {
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
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(IMAGE_BYTES);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
  );
  return { url: `http://127.0.0.1:${port}` };
}

let cacheDir: string;
let cachePath: string;
beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(os.tmpdir(), 'mf-quarantine-'));
  cachePath = path.join(cacheDir, `${IMAGE_DIGEST.slice('sha256:'.length)}.mjs`);
  hoisted.renameCalls.length = 0;
  hoisted.rmCalls.length = 0;
  hoisted.failQuarantineRename = false;
});

function pullSpec(url: string) {
  return parseMachineEntry('stub_machine', `machinen+pull+${url}`);
}

describe('corrupt-entry eviction quarantines before deleting', () => {
  test('the rm targets a unique quarantine name, never the live cache path', async () => {
    const origin = await startOrigin();
    await writeFile(cachePath, 'corrupted bytes that do not match the digest');

    const resolution = await resolvePullEntry(pullSpec(origin.url), { cacheDir });

    expect(resolution.fromCache).toBe(false);
    expect(await readFile(cachePath)).toEqual(IMAGE_BYTES);

    // The corrupt file moved aside to <cachePath>.evict-<pid>-<rand> ...
    const evict = hoisted.renameCalls.find((c) => c.from === cachePath);
    expect(evict).toBeDefined();
    expect(evict!.to).toMatch(
      new RegExp(`^${cachePath.replace(/[.\\/]/g, '\\$&')}\\.evict-\\d+-[a-z0-9]+$`),
    );
    // ... and the delete hit the quarantine name only — a path no concurrent
    // committer can ever rename a fresh file onto.
    expect(hoisted.rmCalls).toContain(evict!.to);
    expect(hoisted.rmCalls).not.toContain(cachePath);

    // No quarantine litter left behind.
    expect(await readdir(cacheDir)).toEqual([path.basename(cachePath)]);
  });

  test('a failed quarantine rename degrades to the direct rm, and the pull still recovers', async () => {
    const origin = await startOrigin();
    await writeFile(cachePath, 'corrupted bytes that do not match the digest');
    hoisted.failQuarantineRename = true;

    const resolution = await resolvePullEntry(pullSpec(origin.url), { cacheDir });

    expect(resolution.fromCache).toBe(false);
    expect(await readFile(cachePath)).toEqual(IMAGE_BYTES);
    // Fallback path: the direct rm-by-path of the old behavior.
    expect(hoisted.rmCalls).toContain(cachePath);
    expect(await readdir(cacheDir)).toEqual([path.basename(cachePath)]);
  });
});
