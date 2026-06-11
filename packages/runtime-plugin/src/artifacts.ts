import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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

function fail(spec: MachineSpec, message: string): never {
  throw new Error(`[machinen-plugin] pull "${spec.remoteName}" (${spec.entry}): ${message}`);
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

async function fetchOk(spec: MachineSpec, url: string, what: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (error) {
    fail(spec, `${what} request to ${url} failed: ${(error as Error).message}`);
  }
  if (!res.ok) fail(spec, `${what} request to ${url} answered ${res.status}`);
  return res;
}

function checkOriginVersion(spec: MachineSpec, manifest: MachineExposeManifest): void {
  const required = spec.params.get('version');
  if (!required) return;
  const actual = manifest.version;
  if (!actual || !semverValid(actual)) {
    throw new MachineVersionError(
      `[machinen-plugin] pull "${spec.remoteName}": entry requires version "${required}" but the origin manifest has no valid version (got "${actual}")`,
    );
  }
  if (!semverSatisfies(actual, required)) {
    throw new MachineVersionError(
      `[machinen-plugin] pull "${spec.remoteName}": origin version mismatch before download: required "${required}", origin reports "${actual}"`,
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

/** Read a cached artifact if present AND its bytes still match the digest. */
async function readVerifiedCache(cachePath: string, hex: string): Promise<Buffer | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readFile(cachePath);
  } catch {
    return undefined;
  }
  if (sha256Hex(bytes) === hex) return bytes;
  // Corrupt entry (partial write, disk fault): evict and re-download.
  await rm(cachePath, { force: true });
  return undefined;
}

function tempCachePath(cachePath: string): string {
  return `${cachePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
}

async function commitAtomic(temp: string, cachePath: string): Promise<void> {
  try {
    await rename(temp, cachePath);
  } catch (error) {
    // Concurrent writers race the same destination. Content is
    // digest/content-addressed, so whoever landed first wrote the same
    // bytes — accept it (rename onto an existing file fails on some
    // platforms) as long as the destination actually exists.
    await rm(temp, { force: true });
    try {
      await stat(cachePath);
    } catch {
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
): Promise<number> {
  if (!res.body) fail(spec, 'image artifact response had no body');
  const reader = res.body.getReader();
  const file = await open(temp, 'w');
  const hash = createHash('sha256');
  let bytesFetched = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      hash.update(value);
      bytesFetched += value.byteLength;
      await file.write(value);
    }
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
  cacheDir: string,
): Promise<CachedImage> {
  const hex = parseDigest(spec, expectedDigest, 'image artifact');
  const ext = imageExt(spec, descriptor);
  const cachePath = path.join(cacheDir, `${hex}${ext}`);

  if (await readVerifiedCache(cachePath, hex)) {
    return { localPath: cachePath, bytesFetched: 0, fromCache: true };
  }

  const url = joinArtifactUrl(spec.url!, descriptor.href);
  const res = await fetchOk(spec, url, 'image artifact');
  const temp = tempCachePath(cachePath);
  try {
    const bytesFetched = await streamVerifiedToTemp(spec, res, expectedDigest, temp);
    await commitAtomic(temp, cachePath);
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
  cacheDir: string,
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
  const cached = await ensureImageCached(spec, descriptor, expected ?? '', cacheDir);

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
  cacheDir: string,
  startedAt: number,
): Promise<PullResolution> {
  const descriptor = requireDescriptor(spec, manifest, 'snapshot');
  checkFormat(spec, descriptor, 'app-state@1');
  checkPlatform(spec, descriptor);

  const url = joinArtifactUrl(spec.url!, descriptor.href);
  const res = await fetchOk(spec, url, 'snapshot artifact');
  const snapshotText = await res.text();
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
    cachedImage = await ensureImageCached(spec, imageDescriptor, snapshot.imageDigest!, cacheDir);
  } else {
    // The cache may still hold it (e.g. pinned earlier); ext must come from
    // the image descriptor when present, else we cannot name the file.
    const ext = imageDescriptor ? imageExt(spec, imageDescriptor) : undefined;
    const cachePath = ext ? path.join(cacheDir, `${imageDigest}${ext}`) : undefined;
    const hit = cachePath && (await readVerifiedCache(cachePath, imageDigest));
    if (!hit || !cachePath) {
      fail(
        spec,
        `snapshot references image digest "${snapshot.imageDigest}" but the origin ` +
          (originDigest
            ? `serves "${originDigest}"`
            : 'publishes no image artifact') +
          ' and the digest is not in the local cache',
      );
    }
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
  const snapPath = path.join(cacheDir, `${sha256Hex(bundleJson)}.snap`);
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
  const cacheDir = options.cacheDir ?? DEFAULT_ARTIFACT_CACHE_DIR;
  await mkdir(cacheDir, { recursive: true });

  const manifestUrl = `${spec.url.replace(/\/+$/, '')}/mf-manifest.json`;
  const res = await fetchOk(spec, manifestUrl, 'origin manifest');
  const manifest = (await res.json().catch(() => undefined)) as MachineExposeManifest | undefined;
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
      return resolveImage(spec, manifest, cacheDir, startedAt);
    case 'snapshot':
      return resolveSnapshot(spec, manifest, cacheDir, startedAt);
    default: {
      const unreachable: never = artifact;
      throw new Error(`[machinen-plugin] unknown artifact kind: ${String(unreachable)}`);
    }
  }
}
