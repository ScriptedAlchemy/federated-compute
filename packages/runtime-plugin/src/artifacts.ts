import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import semverSatisfies from 'semver/functions/satisfies.js';
import semverValid from 'semver/functions/valid.js';
import { MachineVersionError } from './errors.js';
import {
  formatMachineEntry,
  type ArtifactDescriptor,
  type MachineExposeManifest,
  type MachineSpec,
} from './types.js';

/**
 * Consumer side of pull federation: resolve a `machinen+pull+http(s)://`
 * entry by fetching the origin's manifest, downloading the selected artifact
 * into a sha256-addressed cache, and rewriting the spec to a local
 * `kind: 'image'` boot that the existing drivers handle unchanged — the
 * machine analog of MF fetching `remoteEntry.js` from the remote's deploy.
 */

export const DEFAULT_ARTIFACT_CACHE_DIR = path.join('.machinen', 'cache');

const DIGEST_RE = /^sha256:([a-f0-9]{64})$/;
// Drivers dispatch boot commands on the extension; a hostile manifest must
// not be able to write outside the cache dir through it.
const EXT_RE = /^\.[A-Za-z0-9]{1,16}$/;

export type PullArtifactKind = 'image' | 'snapshot';

export interface PullResolution {
  /** The spec rewritten for local boot (`kind: 'image'`, `image` = cached path). */
  spec: MachineSpec;
  artifact: PullArtifactKind;
  descriptor: ArtifactDescriptor;
  /** The driver-bootable file the artifact was materialized into. */
  localPath: string;
  /** Bytes downloaded over the network (0 on a full cache hit). */
  bytesFetched: number;
  /** True when the immutable artifact was already in the digest cache. */
  fromCache: boolean;
  durationMs: number;
}

export interface ResolvePullOptions {
  /** Where artifacts are cached. Default: .machinen/cache */
  cacheDir?: string;
  /**
   * Deadline for header/small fetches: the manifest, the snapshot body, and
   * an artifact response's headers. Default 30s.
   */
  fetchTimeoutMs?: number;
  /**
   * Max stall between streamed artifact body chunks before the download is
   * failed and cancelled. Resets on every chunk, so it bounds stalls without
   * capping the total transfer time of large artifacts. Default 30s.
   */
  streamIdleTimeoutMs?: number;
}

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30_000;

/** ResolvePullOptions with defaults applied, threaded through resolution. */
interface PullContext {
  cacheDir: string;
  fetchTimeoutMs: number;
  streamIdleTimeoutMs: number;
}

/** The wire shape of an `app-state@1` snapshot (`GET /mf-snapshot`). */
interface PulledSnapshot {
  name?: string;
  imageDigest?: string;
  state?: unknown;
  createdAt?: string;
}

/** The process driver's .snap bundle shape (see drivers/process.ts). */
interface MaterializedSnapBundle {
  name: string;
  image: string;
  state: unknown;
  createdAt: string;
}

function failMessage(spec: MachineSpec, message: string): string {
  return `[machinen-plugin] pull "${spec.remoteName}" (${spec.entry}): ${message}`;
}

function fail(spec: MachineSpec, message: string): never {
  throw new Error(failMessage(spec, message));
}

function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hostPlatform(): string {
  return `${process.platform}/${process.arch}`;
}

/**
 * Join an artifact href onto the entry's base URL. Absolute http(s) hrefs
 * pass through; everything else is appended to the base — deliberately NOT
 * host-root-relative URL semantics, so a registry living under a path
 * (`machinen+pull+http://reg/machines/m`) serves `/mf-image` from its own
 * prefix, exactly like a live guest does from its origin root.
 */
export function joinArtifactUrl(base: string, href: string): string {
  if (/^https?:\/\//.test(href)) return href;
  return `${base.replace(/\/+$/, '')}/${href.replace(/^\/+/, '')}`;
}

/**
 * Fetch with a deadline. `scope: 'request'` bounds the entire exchange —
 * right for the small JSON fetches (manifest, snapshot) whose bodies are
 * read immediately after. `scope: 'headers'` disarms the deadline once the
 * response starts: a GB-scale artifact body must not be capped by a flat
 * timeout, so streaming callers bound stalls with the idle timeout instead.
 */
async function fetchOk(
  spec: MachineSpec,
  url: string,
  what: string,
  timeoutMs: number,
  scope: 'request' | 'headers' = 'request',
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
    if (signal.aborted) fail(spec, `${what} request to ${url} timed out after ${timeoutMs}ms`);
    fail(spec, `${what} request to ${url} failed: ${(error as Error).message}`);
  } finally {
    clearTimeout(headerTimer);
  }
  if (!res.ok) fail(spec, `${what} request to ${url} answered ${res.status}`);
  return res;
}

/**
 * Read a small response body whose request carries a 'request'-scoped
 * deadline, converting a mid-body abort into the machine-named timeout
 * error instead of a bare DOMException.
 */
async function readBodyOk(
  spec: MachineSpec,
  res: Response,
  url: string,
  what: string,
  timeoutMs: number,
): Promise<string> {
  try {
    return await res.text();
  } catch (error) {
    if ((error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError') {
      fail(spec, `${what} request to ${url} timed out after ${timeoutMs}ms while reading the body`);
    }
    fail(spec, `${what} body from ${url} could not be read: ${(error as Error).message}`);
  }
}

function checkOriginVersion(spec: MachineSpec, manifest: MachineExposeManifest): void {
  const required = spec.params.get('version');
  if (!required) return;
  const actual = manifest.version;
  if (!actual || !semverValid(actual)) {
    throw new MachineVersionError(
      `[machinen-plugin] pull "${spec.remoteName}": entry requires version "${required}" but the origin manifest has no valid version (got "${actual}")`,
      { required, reported: actual },
    );
  }
  if (!semverSatisfies(actual, required)) {
    throw new MachineVersionError(
      `[machinen-plugin] pull "${spec.remoteName}": origin version mismatch before download: required "${required}", origin reports "${actual}"`,
      { required, reported: actual },
    );
  }
}

function checkPlatform(spec: MachineSpec, descriptor: ArtifactDescriptor): void {
  const platform = descriptor.platform ?? 'any';
  if (platform !== 'any' && platform !== hostPlatform()) {
    fail(
      spec,
      `artifact is published for platform "${platform}" but this host is "${hostPlatform()}"`,
    );
  }
}

function parseDigest(spec: MachineSpec, digest: string | undefined, where: string): string {
  const match = digest ? DIGEST_RE.exec(digest) : null;
  if (!match) fail(spec, `${where} carries no valid sha256 digest (got "${digest}")`);
  return match[1];
}

function imageExt(spec: MachineSpec, descriptor: ArtifactDescriptor): string {
  const ext = descriptor.ext ?? path.extname(descriptor.href);
  if (!ext) {
    fail(
      spec,
      'image descriptor has no file extension ("ext") — drivers pick boot commands by extension',
    );
  }
  if (!EXT_RE.test(ext)) fail(spec, `image descriptor has an unusable ext "${ext}"`);
  return ext;
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
async function verifyCachedFile(cachePath: string, hex: string): Promise<boolean> {
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
async function quarantineEvict(cachePath: string): Promise<void> {
  const quarantine = `${cachePath}.evict-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await rename(cachePath, quarantine);
  } catch {
    await rm(cachePath, { force: true }).catch(() => {});
    return;
  }
  await rm(quarantine, { force: true }).catch(() => {});
}

function tempCachePath(cachePath: string): string {
  return `${cachePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Rename temp onto its content-addressed destination. When the rename loses
 * a race (rename onto an existing file fails on some platforms), `verifyHex`
 * decides whether the existing destination is acceptable: content addressing
 * only guarantees same-bytes for files that actually match their digest — a
 * corrupt pre-existing entry must not win over freshly verified bytes.
 */
async function commitAtomic(temp: string, cachePath: string, verifyHex?: string): Promise<void> {
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

async function writeAtomic(cachePath: string, bytes: Buffer | string): Promise<void> {
  const temp = tempCachePath(cachePath);
  await writeFile(temp, bytes);
  await commitAtomic(temp, cachePath);
}

async function streamVerifiedToTemp(
  spec: MachineSpec,
  res: Response,
  expectedDigest: string,
  temp: string,
  idleTimeoutMs: number,
): Promise<number> {
  if (!res.body) fail(spec, 'image artifact response had no body');
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
      // Each chunk re-arms the idle deadline: a stalled origin is bounded
      // without putting a flat cap on the total transfer time.
      let idleTimer: NodeJS.Timeout | undefined;
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            idleTimer = setTimeout(() => {
              reject(
                new Error(
                  failMessage(
                    spec,
                    `image artifact body stalled: no data for ${idleTimeoutMs}ms (stream idle timeout)`,
                  ),
                ),
              );
            }, idleTimeoutMs);
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

  const actual = `sha256:${hash.digest('hex')}`;
  if (actual !== expectedDigest) {
    fail(
      spec,
      `image digest mismatch: origin advertised "${expectedDigest}" but served bytes hashing to "${actual}" — refusing to cache or boot it`,
    );
  }
  return bytesFetched;
}

interface CachedImage {
  localPath: string;
  bytesFetched: number;
  fromCache: boolean;
}

/**
 * Ensure the image with `expectedDigest` is in the cache, downloading and
 * verifying it when missing. The cache key is the digest itself, so a hit
 * never goes to the network.
 */
async function ensureImageCached(
  spec: MachineSpec,
  descriptor: ArtifactDescriptor,
  expectedDigest: string,
  ctx: PullContext,
): Promise<CachedImage> {
  const hex = parseDigest(spec, expectedDigest, 'image artifact');
  const ext = imageExt(spec, descriptor);
  const cachePath = path.join(ctx.cacheDir, `${hex}${ext}`);

  if (await verifyCachedFile(cachePath, hex)) {
    return { localPath: cachePath, bytesFetched: 0, fromCache: true };
  }

  const url = joinArtifactUrl(spec.url!, descriptor.href);
  // 'headers' scope: the body is a stream guarded by the idle timeout.
  const res = await fetchOk(spec, url, 'image artifact', ctx.fetchTimeoutMs, 'headers');
  const temp = tempCachePath(cachePath);
  try {
    const bytesFetched = await streamVerifiedToTemp(
      spec,
      res,
      expectedDigest,
      temp,
      ctx.streamIdleTimeoutMs,
    );
    await commitAtomic(temp, cachePath, hex);
    return { localPath: cachePath, bytesFetched, fromCache: false };
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function selectArtifact(spec: MachineSpec): PullArtifactKind {
  const artifact = spec.params.get('artifact') ?? 'image';
  if (artifact !== 'image' && artifact !== 'snapshot') {
    fail(spec, `unknown ?artifact= value "${artifact}" (expected "image" or "snapshot")`);
  }
  return artifact;
}

function requireDescriptor(
  spec: MachineSpec,
  manifest: MachineExposeManifest,
  artifact: PullArtifactKind,
): ArtifactDescriptor {
  const descriptor = manifest.artifacts?.[artifact];
  if (!descriptor) {
    const published = Object.keys(manifest.artifacts ?? {});
    fail(
      spec,
      `the machine publishes no "${artifact}" artifact` +
        (published.length ? ` (published: ${published.join(', ')})` : ' (no artifacts block)') +
        ' — pull needs a publishing machine or registry; use a machinen+http:// entry to attach instead',
    );
  }
  return descriptor;
}

function checkFormat(spec: MachineSpec, descriptor: ArtifactDescriptor, expected: string): void {
  if (descriptor.format !== expected) {
    fail(
      spec,
      `unsupported artifact format "${descriptor.format}" (this resolver supports "${expected}")`,
    );
  }
}

/** Rewrite a resolved pull spec to the local-image boot the drivers understand. */
function rewriteSpec(spec: MachineSpec, localPath: string): MachineSpec {
  const rewritten: MachineSpec = {
    remoteName: spec.remoteName,
    entry: '',
    kind: 'image',
    image: localPath,
    params: new URLSearchParams(spec.params),
    pulledFrom: spec.entry,
  };
  rewritten.entry = formatMachineEntry(rewritten);
  return rewritten;
}

async function resolveImage(
  spec: MachineSpec,
  manifest: MachineExposeManifest,
  ctx: PullContext,
  startedAt: number,
): Promise<PullResolution> {
  const descriptor = requireDescriptor(spec, manifest, 'image');
  checkFormat(spec, descriptor, 'guest-bundle');
  checkPlatform(spec, descriptor);

  const pinned = spec.params.get('digest');
  if (pinned && descriptor.digest && pinned !== descriptor.digest) {
    fail(
      spec,
      `entry pins digest "${pinned}" but the origin offers "${descriptor.digest}" — the origin's artifact changed`,
    );
  }
  const expected = pinned ?? descriptor.digest;
  const cached = await ensureImageCached(spec, descriptor, expected ?? '', ctx);

  return {
    spec: rewriteSpec(spec, cached.localPath),
    artifact: 'image',
    descriptor,
    localPath: cached.localPath,
    bytesFetched: cached.bytesFetched,
    fromCache: cached.fromCache,
    durationMs: Date.now() - startedAt,
  };
}

async function resolveSnapshot(
  spec: MachineSpec,
  manifest: MachineExposeManifest,
  ctx: PullContext,
  startedAt: number,
): Promise<PullResolution> {
  const descriptor = requireDescriptor(spec, manifest, 'snapshot');
  checkFormat(spec, descriptor, 'app-state@1');
  checkPlatform(spec, descriptor);

  const url = joinArtifactUrl(spec.url!, descriptor.href);
  const res = await fetchOk(spec, url, 'snapshot artifact', ctx.fetchTimeoutMs);
  const snapshotText = await readBodyOk(spec, res, url, 'snapshot artifact', ctx.fetchTimeoutMs);
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshotText);
  } catch {
    fail(spec, `snapshot artifact at ${url} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const got = parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : `a ${typeof parsed}`;
    fail(spec, `snapshot artifact at ${url} is not a JSON object (got ${got})`);
  }
  const snapshot = parsed as PulledSnapshot;
  const imageDigest = parseDigest(spec, snapshot.imageDigest, 'snapshot');
  if (snapshot.state === undefined) fail(spec, `snapshot artifact at ${url} carries no "state"`);

  // A ?digest= pin on a snapshot pull constrains the IMAGE the snapshot
  // references — "a warm clone, but only of exactly this code". Live
  // snapshot bytes change per request, so they are the one thing a pin
  // cannot mean. Checked before any image bytes move.
  const pinned = spec.params.get('digest');
  if (pinned && pinned !== snapshot.imageDigest) {
    fail(
      spec,
      `entry pins digest "${pinned}" but the pulled snapshot references image digest "${snapshot.imageDigest}" — the origin is running different code`,
    );
  }

  // State travels by value; the image only by digest reference. Resolve the
  // reference: the cache first, then the origin's image artifact — but only
  // when the origin still serves the digest the snapshot references.
  const imageDescriptor = manifest.artifacts?.image;
  const originDigest = imageDescriptor?.digest;
  let cachedImage: CachedImage;
  if (imageDescriptor && originDigest === snapshot.imageDigest) {
    checkPlatform(spec, imageDescriptor);
    cachedImage = await ensureImageCached(spec, imageDescriptor, snapshot.imageDigest!, ctx);
  } else {
    // The cache may still hold it (e.g. pinned earlier); ext must come from
    // the image descriptor when present, else we cannot name the file.
    const notCached: () => never = () =>
      fail(
        spec,
        `snapshot references image digest "${snapshot.imageDigest}" but the origin ` +
          (originDigest
            ? `serves "${originDigest}"`
            : 'publishes no image artifact') +
          ' and the digest is not in the local cache',
      );
    if (!imageDescriptor) notCached();
    const cachePath = path.join(ctx.cacheDir, `${imageDigest}${imageExt(spec, imageDescriptor)}`);
    if (!(await verifyCachedFile(cachePath, imageDigest))) notCached();
    cachedImage = { localPath: cachePath, bytesFetched: 0, fromCache: true };
  }

  const bundle: MaterializedSnapBundle = {
    name: typeof snapshot.name === 'string' ? snapshot.name : spec.remoteName,
    image: cachedImage.localPath,
    state: snapshot.state,
    createdAt:
      typeof snapshot.createdAt === 'string' ? snapshot.createdAt : new Date().toISOString(),
  };
  const bundleJson = JSON.stringify(bundle, null, 2);
  // Content-addressed bundle name: identical pulled state reuses one file,
  // and a memoized resolution stays valid across crash-restarts.
  const snapPath = path.join(ctx.cacheDir, `${sha256Hex(bundleJson)}.snap`);
  await writeAtomic(snapPath, bundleJson);

  return {
    spec: rewriteSpec(spec, snapPath),
    artifact: 'snapshot',
    descriptor,
    localPath: snapPath,
    bytesFetched: cachedImage.bytesFetched + Buffer.byteLength(snapshotText),
    fromCache: cachedImage.fromCache,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Resolve a `kind: 'pull'` spec into a locally bootable `kind: 'image'` spec.
 * Fetches the origin manifest, negotiates the entry's `?version=` BEFORE any
 * artifact bytes move, verifies digests, and materializes the artifact in
 * the shape the process driver already boots (a program file or a `.snap`
 * bundle whose `image` points into the cache).
 */
export async function resolvePullEntry(
  spec: MachineSpec,
  options: ResolvePullOptions = {},
): Promise<PullResolution> {
  if (spec.kind !== 'pull' || !spec.url) {
    throw new Error(
      `[machinen-plugin] resolvePullEntry expects a machinen+pull+http(s):// entry, got "${spec.entry}"`,
    );
  }
  const startedAt = Date.now();
  const ctx: PullContext = {
    cacheDir: options.cacheDir ?? DEFAULT_ARTIFACT_CACHE_DIR,
    fetchTimeoutMs: options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  };
  await mkdir(ctx.cacheDir, { recursive: true });

  const manifestUrl = `${spec.url.replace(/\/+$/, '')}/mf-manifest.json`;
  const res = await fetchOk(spec, manifestUrl, 'origin manifest', ctx.fetchTimeoutMs);
  const manifestText = await readBodyOk(spec, res, manifestUrl, 'origin manifest', ctx.fetchTimeoutMs);
  let manifest: MachineExposeManifest | undefined;
  try {
    manifest = JSON.parse(manifestText) as MachineExposeManifest;
  } catch {
    manifest = undefined; // non-JSON manifests fall through to the protocol check
  }
  if (manifest?.protocol !== 3) {
    fail(
      spec,
      `origin at ${manifestUrl} is not a protocol v3 machine (got protocol ${String(manifest?.protocol)})`,
    );
  }
  // Fail fast on version mismatch, before any artifact bytes move. The
  // booted clone is re-validated by the plugin's own checkVersion.
  checkOriginVersion(spec, manifest);

  const artifact = selectArtifact(spec);
  switch (artifact) {
    case 'image':
      return resolveImage(spec, manifest, ctx, startedAt);
    case 'snapshot':
      return resolveSnapshot(spec, manifest, ctx, startedAt);
    default: {
      const unreachable: never = artifact;
      throw new Error(`[machinen-plugin] unknown artifact kind: ${String(unreachable)}`);
    }
  }
}
