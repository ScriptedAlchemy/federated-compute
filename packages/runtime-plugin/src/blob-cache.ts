import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

/**
 * Content-addressed file-cache primitives shared by the Phase 1 artifact
 * resolver (artifacts.ts) and the Phase 2 vmstate blob fetcher (vmstate.ts):
 * deadline-bounded fetch, idle-timeout-guarded streaming with on-the-fly
 * hashing, memoized digest verification, quarantine eviction of corrupt
 * entries, atomic commit, and in-flight download coalescing. Both consumers
 * verify GB-scale payloads, so everything here streams — nothing buffers a
 * whole artifact in memory.
 *
 * Error-message templates are parameterized (failFn / message factories):
 * artifacts.ts speaks "[machinen-plugin] pull ..." while vmstate.ts speaks
 * bare "blob ..." messages that its callers wrap.
 */

export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30_000;

export type FailFn = (message: string) => never;

/**
 * Fetch with a deadline. `scope: 'request'` bounds the entire exchange —
 * right for the small JSON fetches (manifest, snapshot) whose bodies are
 * read immediately after. `scope: 'headers'` disarms the deadline once the
 * response starts: a GB-scale artifact body must not be capped by a flat
 * timeout, so streaming callers bound stalls with the idle timeout instead.
 */
export async function fetchOkWith(
  url: string,
  what: string,
  timeoutMs: number,
  scope: 'request' | 'headers',
  failFn: FailFn,
): Promise<Response> {
  let headerTimer: NodeJS.Timeout | undefined;
  let signal: AbortSignal;
  if (scope === 'headers') {
    const controller = new AbortController();
    headerTimer = setTimeout(() => controller.abort(), timeoutMs);
    headerTimer.unref?.();
    signal = controller.signal;
  } else {
    signal = AbortSignal.timeout(timeoutMs);
  }
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (error) {
    if (signal.aborted) failFn(`${what} request to ${url} timed out after ${timeoutMs}ms`);
    failFn(`${what} request to ${url} failed: ${(error as Error).message}`);
  } finally {
    clearTimeout(headerTimer);
  }
  if (!res.ok) failFn(`${what} request to ${url} answered ${res.status}`);
  return res;
}

interface VerifyMemoEntry {
  hex: string;
  size: number;
  mtimeMs: number;
}

/**
 * Files this process has already hash-verified, keyed by absolute path. A
 * memo hit (same size + mtime) skips the O(size) re-hash that would
 * otherwise run on EVERY cache hit — fatal to "near-instant HIT" at GB
 * scale. Accepted edge: a tamper that preserves both size and mtime passes
 * the memo within this process; cross-process paranoia is preserved because
 * every process full-hashes a file on first touch.
 */
const verifyMemo = new Map<string, VerifyMemoEntry>();

/** Test-only observability for the memo (counts hits vs full hashes). */
export const verifyMemoCounters = { hits: 0, fullVerifies: 0 };

/** Test-only: clear the verification memo and its counters. */
export function resetVerifyMemo(): void {
  verifyMemo.clear();
  verifyMemoCounters.hits = 0;
  verifyMemoCounters.fullVerifies = 0;
}

/**
 * True when the cached artifact exists AND still hashes to the digest.
 * Streams the verification: `readFile` would buffer the whole artifact and
 * hard-fail at >=2GiB (ERR_FS_FILE_TOO_LARGE), silently breaking the cache
 * at exactly the bundle sizes vmstate federation targets.
 */
export async function verifyCachedFile(cachePath: string, hex: string): Promise<boolean> {
  const memoKey = path.resolve(cachePath);
  let entryStat;
  try {
    entryStat = await stat(cachePath);
  } catch {
    verifyMemo.delete(memoKey);
    return false; // missing: a plain miss, nothing to evict
  }
  const memo = verifyMemo.get(memoKey);
  if (
    memo &&
    memo.hex === hex &&
    memo.size === entryStat.size &&
    memo.mtimeMs === entryStat.mtimeMs
  ) {
    verifyMemoCounters.hits++;
    return true;
  }
  verifyMemo.delete(memoKey);

  verifyMemoCounters.fullVerifies++;
  const hash = createHash('sha256');
  try {
    const stream: AsyncIterable<Buffer> = createReadStream(cachePath);
    for await (const chunk of stream) {
      hash.update(chunk);
    }
  } catch {
    // Unreadable (even a directory squatting on the path): treat as a miss
    // and clear the way so the re-download can land.
    await rm(cachePath, { recursive: true, force: true }).catch(() => {});
    return false;
  }
  if (hash.digest('hex') === hex) {
    // Record the pre-read stat: if the file changed mid-hash, the next
    // verify sees a stale memo and re-hashes instead of trusting it.
    verifyMemo.set(memoKey, { hex, size: entryStat.size, mtimeMs: entryStat.mtimeMs });
    return true;
  }
  // Corrupt entry (partial write, disk fault): evict and re-download. An
  // eviction failure (file held open elsewhere) still degrades to a miss.
  await quarantineEvict(cachePath);
  return false;
}

/**
 * Evict a corrupt cache entry without racing concurrent committers: an
 * rm-by-path could TOCTOU-delete a freshly verified file that a sibling
 * renamed onto the cache path between our hash mismatch and our delete.
 * Renaming the corrupt file to a unique quarantine name first means the
 * delete operates on a path no committer will ever rename onto. A failed
 * rename (entry already replaced/removed, exotic fs) falls back to the
 * direct rm — at worst the old behavior.
 */
export async function quarantineEvict(cachePath: string): Promise<void> {
  const quarantine = `${cachePath}.evict-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await rename(cachePath, quarantine);
  } catch {
    await rm(cachePath, { force: true }).catch(() => {});
    return;
  }
  await rm(quarantine, { force: true }).catch(() => {});
}

export function tempCachePath(cachePath: string): string {
  return `${cachePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Rename temp onto its content-addressed destination. When the rename loses
 * a race (rename onto an existing file fails on some platforms), `verifyHex`
 * decides whether the existing destination is acceptable: content addressing
 * only guarantees same-bytes for files that actually match their digest — a
 * corrupt pre-existing entry must not win over freshly verified bytes.
 */
export async function commitAtomic(temp: string, cachePath: string, verifyHex?: string): Promise<void> {
  try {
    await rename(temp, cachePath);
  } catch (error) {
    await rm(temp, { force: true });
    try {
      await stat(cachePath);
    } catch {
      throw error;
    }
    if (verifyHex && !(await verifyCachedFile(cachePath, verifyHex))) {
      throw error;
    }
  }
}

export interface StreamToTempMessages {
  /** Error for a response without a body. */
  noBody: () => Error;
  /** Error for a stream that stalled past the idle timeout. */
  stalled: (idleTimeoutMs: number) => Error;
}

/**
 * Stream a response body to a temp file, hashing on the fly. Each chunk
 * re-arms the idle deadline: a stalled origin is bounded without putting a
 * flat cap on the total transfer time. Callers compare the returned hex to
 * the expected digest and commit (or discard) the temp file themselves.
 */
export async function streamHashedToTemp(
  res: Response,
  temp: string,
  idleTimeoutMs: number,
  messages: StreamToTempMessages,
): Promise<{ bytesFetched: number; hex: string }> {
  if (!res.body) throw messages.noBody();
  // Open before taking the reader: an open failure must not strand an
  // unconsumed (and uncancellable-by-us) body stream.
  let file: FileHandle;
  try {
    file = await open(temp, 'w');
  } catch (error) {
    await res.body.cancel().catch(() => {});
    throw error;
  }
  const reader = res.body.getReader();
  const hash = createHash('sha256');
  let bytesFetched = 0;
  try {
    for (;;) {
      let idleTimer: NodeJS.Timeout | undefined;
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            idleTimer = setTimeout(() => reject(messages.stalled(idleTimeoutMs)), idleTimeoutMs);
            idleTimer.unref?.();
          }),
        ]);
      } finally {
        clearTimeout(idleTimer);
      }
      const { done, value } = chunk;
      if (done) break;
      hash.update(value);
      bytesFetched += value.byteLength;
      await file.write(value);
    }
  } catch (error) {
    // Mid-stream failure — a write error (ENOSPC at GB scale) or an idle
    // stall: cancel the body so the socket and remaining download die with
    // the request instead of leaking.
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    await file.close();
    reader.releaseLock();
  }
  return { bytesFetched, hex: hash.digest('hex') };
}

/**
 * Join an in-flight operation by key: exactly one caller per key runs the
 * factory, everyone else shares its promise verbatim (including failures).
 * The entry is removed when the operation settles, so a retry runs fresh.
 * No await between the map check and the set — the winner is decided
 * synchronously.
 */
export async function coalesce<T>(
  inflight: Map<string, Promise<T>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const pending = run();
  inflight.set(key, pending);
  try {
    return await pending;
  } finally {
    inflight.delete(key);
  }
}
