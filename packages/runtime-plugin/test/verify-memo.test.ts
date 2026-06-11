import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { resetVerifyMemo, resolvePullEntry, verifyMemoCounters } from '../src/artifacts.js';
import { parseMachineEntry, type MachineExposeManifest } from '../src/types.js';

/**
 * Deferred review finding: every cache hit re-hashed the whole artifact,
 * contradicting "near-instant HIT" at GB scale. A module-level memo keyed
 * by (absolute path, size, mtime) skips the hash for files this process has
 * already verified and that have not visibly changed. First touch per
 * process still pays the full hash, so cross-process paranoia is intact.
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

async function startOrigin(): Promise<{ url: string; imageRequests: () => number }> {
  let imageRequests = 0;
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
      imageRequests++;
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
  return { url: `http://127.0.0.1:${port}`, imageRequests: () => imageRequests };
}

let cacheDir: string;
let cachePath: string;
beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(os.tmpdir(), 'mf-memo-'));
  cachePath = path.join(cacheDir, `${IMAGE_DIGEST.slice('sha256:'.length)}.mjs`);
  resetVerifyMemo();
});

function pullSpec(url: string) {
  return parseMachineEntry('stub_machine', `machinen+pull+${url}`);
}

describe('verification memo', () => {
  test('the second verify of an untouched file is a memo hit — no re-hash', async () => {
    const origin = await startOrigin();

    await resolvePullEntry(pullSpec(origin.url), { cacheDir }); // download
    expect(verifyMemoCounters.fullVerifies).toBe(0); // miss was a stat miss, not a hash

    const second = await resolvePullEntry(pullSpec(origin.url), { cacheDir });
    expect(second.fromCache).toBe(true);
    // First cache hit per process pays the full hash and records the memo.
    expect(verifyMemoCounters.fullVerifies).toBe(1);
    expect(verifyMemoCounters.hits).toBe(0);

    const third = await resolvePullEntry(pullSpec(origin.url), { cacheDir });
    expect(third.fromCache).toBe(true);
    // Untouched file: the memo answers, the hash is skipped.
    expect(verifyMemoCounters.fullVerifies).toBe(1);
    expect(verifyMemoCounters.hits).toBe(1);
    expect(origin.imageRequests()).toBe(1);
  });

  test('touching the file forces a real re-verify that catches the tampering', async () => {
    const origin = await startOrigin();

    await resolvePullEntry(pullSpec(origin.url), { cacheDir });
    await resolvePullEntry(pullSpec(origin.url), { cacheDir }); // memo recorded
    expect(verifyMemoCounters.fullVerifies).toBe(1);

    // Tamper: rewrite the cached file (new size + mtime).
    await writeFile(cachePath, 'tampered bytes that no longer match the digest');

    const after = await resolvePullEntry(pullSpec(origin.url), { cacheDir });

    // The stat mismatch bypassed the memo, the full hash caught the tamper,
    // the entry was evicted and re-downloaded.
    expect(verifyMemoCounters.fullVerifies).toBeGreaterThanOrEqual(2);
    expect(after.fromCache).toBe(false);
    expect(origin.imageRequests()).toBe(2);
    expect(await readFile(cachePath)).toEqual(IMAGE_BYTES);
  });

  test('resetVerifyMemo clears both the memo and the counters', async () => {
    const origin = await startOrigin();
    await resolvePullEntry(pullSpec(origin.url), { cacheDir });
    await resolvePullEntry(pullSpec(origin.url), { cacheDir });
    expect(verifyMemoCounters.fullVerifies).toBe(1);

    resetVerifyMemo();
    expect(verifyMemoCounters.fullVerifies).toBe(0);
    expect(verifyMemoCounters.hits).toBe(0);

    // The memo is gone: the next hit pays the full hash again.
    const next = await resolvePullEntry(pullSpec(origin.url), { cacheDir });
    expect(next.fromCache).toBe(true);
    expect(verifyMemoCounters.fullVerifies).toBe(1);
  });
});
