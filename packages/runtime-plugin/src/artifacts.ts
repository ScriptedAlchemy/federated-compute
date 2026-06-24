import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  coalesce,
  commitAtomic,
  fetchOkWith,
  streamHashedToTemp,
  tempCachePath,
  verifyCachedFile,
} from './blob-cache.js';
import {
  formatMachineEntry,
  type ArtifactDescriptor,
  type MachineExposeManifest,
  type MachineSpec,
} from './types.js';
import { assertManifestVersion } from './compatibility.js';
import {
  VMSTATE_FORMAT,
  ensureBlobCached,
  installedMachinenRuntimeVersion,
  materializeVmstateDir,
  ociHostPlatform,
  parseVmstateBundleManifest,
  vmstateCompatibilityError,
  type CachedBlob,
  type VmstateBundleManifest,
  type VmstateShellIdentity,
} from './vmstate.js';

// Test-only memo observability, re-exported from the shared cache module so
// existing consumers keep importing it from here.
export { resetVerifyMemo, verifyMemoCounters } from './blob-cache.js';

/**
 * Consumer side of pull federation: resolve a `machinen+pull+http(s)://`
 * entry by fetching the origin's manifest, downloading the selected artifact
 * into a sha256-addressed cache, and rewriting the spec to a local
 * `kind: 'image'` boot that the existing drivers handle unchanged — the
 * machine analog of MF fetching `remoteEntry.js` from the remote's deploy.
 */

export const DEFAULT_ARTIFACT_CACHE_DIR = path.join('.machinen', 'cache');
export const DEFAULT_PULL_BODY_MAX_BYTES = 5 * 1024 * 1024;

const DIGEST_RE = /^sha256:([a-f0-9]{64})$/;
// Drivers dispatch boot commands on the extension; a hostile manifest must
// not be able to write outside the cache dir through it.
const EXT_RE = /^\.[A-Za-z0-9]{1,16}$/;

export type PullArtifactKind = 'image' | 'snapshot' | 'vmstate';

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
  /** Max bytes buffered for manifest/snapshot/vmstate JSON bodies. Default 5 MiB. */
  maxBodyBytes?: number;
  /**
   * Override the installed @machinen/runtime version used for vmstate
   * compatibility negotiation. Default: read from the installed package.
   * (Exists for hermetic tests and unusual ops setups.)
   */
  machinenRuntimeVersion?: string;
  /**
   * Local MachineN shell available for vmstate restores. When set, vmstate
   * pulls must declare the same shell before any snapshot blobs are fetched.
   */
  vmstateShell?: VmstateShellIdentity;
}

/** ResolvePullOptions with defaults applied, threaded through resolution. */
interface PullContext {
  cacheDir: string;
  fetchTimeoutMs: number;
  streamIdleTimeoutMs: number;
  maxBodyBytes: number;
  /** Undefined means "read from the installed package" at the vmstate gate. */
  machinenRuntimeVersion?: string;
  vmstateShell?: VmstateShellIdentity;
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

interface CachedVmstateFiles {
  blobPaths: string[];
  bytesFetched: number;
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

/** Deadline-bounded fetch (shared core) that fails with the spec-named message. */
async function fetchOk(
  spec: MachineSpec,
  url: string,
  what: string,
  timeoutMs: number,
  scope: 'request' | 'headers' = 'request',
): Promise<Response> {
  return fetchOkWith(url, what, timeoutMs, scope, (message) => fail(spec, message));
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
  maxBytes: number,
): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`${what} body from ${url} exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      fail(spec, `${what} request to ${url} timed out after ${timeoutMs}ms while reading the body`);
    }
    if (err.message.startsWith(`${what} body from ${url} exceeded `)) {
      fail(spec, err.message);
    }
    fail(spec, `${what} body from ${url} could not be read: ${err.message}`);
  } finally {
    reader.releaseLock();
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

async function writeAtomic(cachePath: string, bytes: Buffer | string): Promise<void> {
  const temp = tempCachePath(cachePath);
  await writeFile(temp, bytes);
  await commitAtomic(temp, cachePath);
}

async function streamVerifiedToTemp(
  spec: MachineSpec,
  res: Response,
  expectedDigest: string,
  expectedBytes: number | undefined,
  temp: string,
  idleTimeoutMs: number,
): Promise<number> {
  const { bytesFetched, hex } = await streamHashedToTemp(
    res,
    temp,
    idleTimeoutMs,
    {
      noBody: () => new Error(failMessage(spec, 'image artifact response had no body')),
      stalled: (ms) =>
        new Error(
          failMessage(
            spec,
            `image artifact body stalled: no data for ${ms}ms (stream idle timeout)`,
          ),
        ),
      exceeded: (maxBytes) =>
        new Error(
          failMessage(spec, `image artifact body exceeded advertised size ${maxBytes} bytes`),
        ),
    },
    expectedBytes,
  );
  const actual = `sha256:${hex}`;
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
 * In-flight downloads by cache path: concurrent pulls of one digest (one
 * entry or many entries sharing an image) join a single download instead of
 * each pulling the full artifact. Entries are removed when the download
 * settles — success lands the file in the cache, failure lets a retry pull
 * fresh. Joiners share the winner's result verbatim (including bytesFetched
 * and any failure, whose message names the winner's entry).
 */
const inflightDownloads = new Map<string, Promise<CachedImage>>();

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

  // Exactly one caller per cache path becomes the downloader, everyone else
  // joins its promise.
  return coalesce(inflightDownloads, cachePath, async (): Promise<CachedImage> => {
    const url = joinArtifactUrl(spec.url!, descriptor.href);
    // 'headers' scope: the body is a stream guarded by the idle timeout.
    const res = await fetchOk(spec, url, 'image artifact', ctx.fetchTimeoutMs, 'headers');
    const temp = tempCachePath(cachePath);
    try {
      const bytesFetched = await streamVerifiedToTemp(
        spec,
        res,
        expectedDigest,
        descriptor.bytes,
        temp,
        ctx.streamIdleTimeoutMs,
      );
      await commitAtomic(temp, cachePath, hex);
      return { localPath: cachePath, bytesFetched, fromCache: false };
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  });
}

function selectArtifact(spec: MachineSpec): PullArtifactKind {
  const artifact = spec.params.get('artifact') ?? 'image';
  if (artifact !== 'image' && artifact !== 'snapshot' && artifact !== 'vmstate') {
    fail(
      spec,
      `unknown ?artifact= value "${artifact}" (expected "image", "snapshot", or "vmstate")`,
    );
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

function parsePulledSnapshot(
  spec: MachineSpec,
  url: string,
  snapshotText: string,
): PulledSnapshot {
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
  return parsed as PulledSnapshot;
}

async function ensureSnapshotImageCached(
  spec: MachineSpec,
  manifest: MachineExposeManifest,
  snapshot: PulledSnapshot,
  imageDigest: string,
  ctx: PullContext,
): Promise<CachedImage> {
  const imageDescriptor = manifest.artifacts?.image;
  const originDigest = imageDescriptor?.digest;
  if (imageDescriptor && originDigest === snapshot.imageDigest) {
    checkPlatform(spec, imageDescriptor);
    return ensureImageCached(spec, imageDescriptor, snapshot.imageDigest!, ctx);
  }

  // The cache may still hold it (e.g. pinned earlier); ext must come from
  // the image descriptor when present, else we cannot name the file.
  const notCached: () => never = () =>
    fail(
      spec,
      `snapshot references image digest "${snapshot.imageDigest}" but the origin ` +
        (originDigest ? `serves "${originDigest}"` : 'publishes no image artifact') +
        ' and the digest is not in the local cache',
    );
  if (!imageDescriptor) notCached();
  const cachePath = path.join(ctx.cacheDir, `${imageDigest}${imageExt(spec, imageDescriptor)}`);
  if (!(await verifyCachedFile(cachePath, imageDigest))) notCached();
  return { localPath: cachePath, bytesFetched: 0, fromCache: true };
}

async function materializeSnapshotBundle(
  spec: MachineSpec,
  snapshot: PulledSnapshot,
  cachedImage: CachedImage,
  ctx: PullContext,
): Promise<string> {
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
  return snapPath;
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
  const snapshotText = await readBodyOk(
    spec,
    res,
    url,
    'snapshot artifact',
    ctx.fetchTimeoutMs,
    ctx.maxBodyBytes,
  );
  const snapshot = parsePulledSnapshot(spec, url, snapshotText);
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
  const cachedImage = await ensureSnapshotImageCached(spec, manifest, snapshot, imageDigest, ctx);
  const snapPath = await materializeSnapshotBundle(spec, snapshot, cachedImage, ctx);

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

function prepareVmstateDescriptor(spec: MachineSpec, descriptor: ArtifactDescriptor): string {
  checkFormat(spec, descriptor, VMSTATE_FORMAT);

  // vmstate is arch-bound and uses the OCI vocabulary; the descriptor gates
  // before the bundle fetch, the bundle manifest is authoritative below.
  const hostOci = ociHostPlatform();
  if (descriptor.platform && descriptor.platform !== 'any' && descriptor.platform !== hostOci) {
    fail(
      spec,
      `vmstate platform mismatch before download: artifact requires "${descriptor.platform}", this host is "${hostOci}"`,
    );
  }

  // ?digest= pins the BUNDLE digest — the immutable identity of a vmstate
  // pull, exactly as image pulls pin the image digest.
  const pinned = spec.params.get('digest');
  if (pinned && descriptor.digest && pinned !== descriptor.digest) {
    fail(
      spec,
      `entry pins digest "${pinned}" but the origin offers "${descriptor.digest}" — the origin's published bundle changed`,
    );
  }
  return parseDigest(spec, pinned ?? descriptor.digest, 'vmstate artifact');
}

async function fetchVmstateBundle(
  spec: MachineSpec,
  descriptor: ArtifactDescriptor,
  expectedHex: string,
  ctx: PullContext,
): Promise<VmstateBundleManifest> {
  const bundleUrl = joinArtifactUrl(spec.url!, descriptor.href);
  const res = await fetchOk(spec, bundleUrl, 'vmstate bundle manifest', ctx.fetchTimeoutMs);
  const bundleText = await readBodyOk(
    spec,
    res,
    bundleUrl,
    'vmstate bundle manifest',
    ctx.fetchTimeoutMs,
    ctx.maxBodyBytes,
  );
  const actualHex = sha256Hex(bundleText);
  if (actualHex !== expectedHex) {
    fail(
      spec,
      `vmstate bundle manifest digest mismatch: expected "sha256:${expectedHex}" but ${bundleUrl} served bytes hashing to "sha256:${actualHex}"`,
    );
  }
  try {
    return parseVmstateBundleManifest(bundleText, `at ${bundleUrl}`);
  } catch (error) {
    fail(spec, (error as Error).message);
  }
}

function assertVmstateRuntimeCompatible(
  spec: MachineSpec,
  bundle: VmstateBundleManifest,
  ctx: PullContext,
): void {
  const machinenRuntime = ctx.machinenRuntimeVersion ?? installedMachinenRuntimeVersion();
  if (!machinenRuntime) {
    fail(
      spec,
      'vmstate pull needs @machinen/runtime installed to negotiate bundle compatibility ' +
        '(it is an optional peer dependency: `pnpm add @machinen/runtime@0.6.1`)',
    );
  }
  if (!ctx.vmstateShell) {
    fail(
      spec,
      'vmstate pull needs vmstateShell in the plugin or resolver options; refusing to restore ' +
        'state without a local MachineN shell identity',
    );
  }
  const incompatible = vmstateCompatibilityError(bundle.compatibility, {
    platform: ociHostPlatform(),
    machinenRuntime,
    shell: ctx.vmstateShell,
  });
  if (incompatible) fail(spec, incompatible);
}

async function cacheVmstateFiles(
  spec: MachineSpec,
  bundle: VmstateBundleManifest,
  ctx: PullContext,
): Promise<CachedVmstateFiles> {
  const blobDir = path.join(ctx.cacheDir, 'blobs', 'sha256');
  let bytesFetched = 0;
  const blobPaths: string[] = [];
  for (const file of bundle.files) {
    let blob: CachedBlob;
    try {
      blob = await ensureBlobCached(joinArtifactUrl(spec.url!, file.href), file, blobDir, {
        fetchTimeoutMs: ctx.fetchTimeoutMs,
        streamIdleTimeoutMs: ctx.streamIdleTimeoutMs,
      });
    } catch (error) {
      fail(spec, (error as Error).message);
    }
    bytesFetched += blob.fetched;
    blobPaths.push(blob.localPath);
  }
  return { blobPaths, bytesFetched };
}

async function resolveVmstate(
  spec: MachineSpec,
  manifest: MachineExposeManifest,
  ctx: PullContext,
  startedAt: number,
): Promise<PullResolution> {
  const descriptor = requireDescriptor(spec, manifest, 'vmstate');
  const expectedHex = prepareVmstateDescriptor(spec, descriptor);
  const bundle = await fetchVmstateBundle(spec, descriptor, expectedHex, ctx);

  // The requiredVersion analog for hardware/runtime: reject BEFORE any blob
  // bytes move, with a negotiation-style error instead of a VMM crash.
  assertVmstateRuntimeCompatible(spec, bundle, ctx);
  const { blobPaths, bytesFetched } = await cacheVmstateFiles(spec, bundle, ctx);

  const destDir = path.join(ctx.cacheDir, 'vmstate', `sha256-${expectedHex}`);
  await materializeVmstateDir(bundle, blobPaths, destDir);

  return {
    spec: rewriteSpec(spec, destDir),
    artifact: 'vmstate',
    descriptor,
    localPath: destDir,
    bytesFetched,
    fromCache: bytesFetched === 0,
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
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_PULL_BODY_MAX_BYTES,
    machinenRuntimeVersion: options.machinenRuntimeVersion,
    vmstateShell: options.vmstateShell,
  };
  await mkdir(ctx.cacheDir, { recursive: true });

  const manifestUrl = `${spec.url.replace(/\/+$/, '')}/mf-manifest.json`;
  const res = await fetchOk(spec, manifestUrl, 'origin manifest', ctx.fetchTimeoutMs);
  const manifestText = await readBodyOk(
    spec,
    res,
    manifestUrl,
    'origin manifest',
    ctx.fetchTimeoutMs,
    ctx.maxBodyBytes,
  );
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
  // booted clone is re-validated by the plugin's guest compatibility gate.
  assertManifestVersion(spec, manifest, 'pull-origin');

  const artifact = selectArtifact(spec);
  switch (artifact) {
    case 'image':
      return resolveImage(spec, manifest, ctx, startedAt);
    case 'snapshot':
      return resolveSnapshot(spec, manifest, ctx, startedAt);
    case 'vmstate':
      return resolveVmstate(spec, manifest, ctx, startedAt);
    default: {
      const unreachable: never = artifact;
      throw new Error(`[machinen-plugin] unknown artifact kind: ${String(unreachable)}`);
    }
  }
}
