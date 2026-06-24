import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, link, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
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

/**
 * machinen-vmstate@1 — the whole-VM artifact format of Phase 2 pull
 * federation. A bundle manifest names every file of a machinen snapshot
 * directory by sha256 digest; blobs are stored and served content-addressed.
 * Shared by the producer (the plugin-owned publisher in publish.ts) and the
 * consumer (the pull resolver in artifacts.ts) so the two sides cannot drift.
 *
 * Errors thrown here carry no "[machinen-plugin]" prefix: callers (resolver
 * fail(), publisher) add their own context.
 */

export const VMSTATE_FORMAT = 'machinen-vmstate@1';
export const VMSTATE_SNAPSHOT_ENGINE = 'machinen-default';
/** The reseed mechanism handle.snapshot() bakes in before every dump. */
export const VMSTATE_RESEED = 'machinen-0.4.0-shim@1';

const DIGEST_RE = /^sha256:([a-f0-9]{64})$/;
// One path segment of a bundle file. Dots-only names ("..", ".") and
// separator characters are rejected: a hostile bundle manifest must not be
// able to write outside the materialize dir.
const SEGMENT_RE = /^(?!\.+$)[A-Za-z0-9._-]+$/;

export interface VmstateFileEntry {
  /** Relative path inside the snapshot directory (e.g. "state.vmstate"). */
  path: string;
  /** Machine-base-relative blob URL (e.g. "blobs/sha256/<hex>"). */
  href: string;
  /** sha256:<hex> of the file bytes. */
  digest: string;
  bytes: number;
}

export interface VmstateShellIdentity {
  /** Digest of the MachineN rootfs/base image the VM was booted from. */
  rootfsDigest: string;
  /** Digest of the guest kernel supplied for boot/restore. */
  kernelDigest: string;
  /** Digest of the guest dtb when the architecture uses one. */
  dtbDigest?: string;
}

export function isVmstateShellIdentity(value: unknown): value is VmstateShellIdentity {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.rootfsDigest === 'string' &&
    DIGEST_RE.test(value.rootfsDigest) &&
    typeof value.kernelDigest === 'string' &&
    DIGEST_RE.test(value.kernelDigest) &&
    (value.dtbDigest === undefined ||
      (typeof value.dtbDigest === 'string' && DIGEST_RE.test(value.dtbDigest)))
  );
}

export function assertVmstateShellIdentity(
  value: unknown,
  what: string,
): VmstateShellIdentity {
  if (isVmstateShellIdentity(value)) return value;
  throw new Error(`${what} must include shell rootfs/kernel digests as sha256:<hex>`);
}

export interface VmstateCompatibility {
  /** OCI-style platform, e.g. "linux/amd64" — vmstate is arch-bound. */
  platform: string;
  /** Exact @machinen/runtime version the bundle was dumped under. */
  machinenRuntime: string;
  vmstateFormat: typeof VMSTATE_FORMAT;
  /** Snapshot engine that produced the dump; consumers reject unknown values. */
  snapshotEngine: string;
  /** Reseed mechanism baked into the bundle before the dump. */
  reseed: string;
  /**
   * Stable identity of the local MachineN shell this state belongs to. The
   * current MachineN restore API still restores the bundle's root disk, but
   * this lets schedulers reject incompatible regions before multi-GB state
   * transfer and prepares the artifact contract for state/delta restores.
   */
  shell: VmstateShellIdentity;
}

export interface VmstateBundleManifest {
  format: typeof VMSTATE_FORMAT;
  name: string;
  createdAt: string;
  compatibility: VmstateCompatibility;
  files: VmstateFileEntry[];
}

/**
 * Node arch -> OCI platform vocabulary. Registries and CI summaries outlive
 * one Node process, so vmstate uses the stable wire names (linux/amd64), not
 * process.arch (linux/x64). Phase 1 artifacts keep the Node-style vocabulary
 * in artifacts.checkPlatform — only vmstate is arch-bound enough to care.
 */
export function ociHostPlatform(): string {
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  return `${process.platform}/${arch}`;
}

/** Streaming sha256 of a file — multi-GB vmstate never fits in memory. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export interface BuiltVmstateBundle {
  manifest: VmstateBundleManifest;
  /** Absolute source path per manifest.files entry (same order). */
  sources: string[];
}

/**
 * Hash every file of a snapshot directory into a bundle manifest. Walks the
 * directory instead of assuming the three known files (meta.json,
 * state.vmstate, federated-machine.json): machinen owns the bundle contents
 * and may add files across versions.
 */
export async function buildVmstateBundle(
  snapDir: string,
  opts: { name: string; compatibility: VmstateCompatibility; createdAt?: string },
): Promise<BuiltVmstateBundle> {
  const names = await readdir(snapDir, { recursive: true });
  const files: VmstateFileEntry[] = [];
  const sources: string[] = [];
  for (const name of [...names].sort()) {
    const absolute = path.join(snapDir, name);
    const info = await stat(absolute);
    if (!info.isFile()) continue;
    const relative = name.split(path.sep).join('/');
    const hex = await sha256File(absolute);
    files.push({
      path: relative,
      href: `blobs/sha256/${hex}`,
      digest: `sha256:${hex}`,
      bytes: info.size,
    });
    sources.push(absolute);
  }
  if (!files.length) {
    throw new Error(`vmstate bundle: ${snapDir} contains no files`);
  }
  return {
    manifest: {
      format: VMSTATE_FORMAT,
      name: opts.name,
      createdAt: opts.createdAt ?? new Date().toISOString(),
      compatibility: opts.compatibility,
      files,
    },
    sources,
  };
}

function parseFail(where: string, message: string): never {
  throw new Error(`vmstate bundle manifest ${where} ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const COMPATIBILITY_STRING_FIELDS = [
  'platform',
  'machinenRuntime',
  'snapshotEngine',
  'reseed',
] as const;

/** Safe relative bundle path: non-empty slash-joined SEGMENT_RE segments. */
export function isSafeBundlePath(candidate: string): boolean {
  if (!candidate || candidate.length > 512) return false;
  return candidate.split('/').every((segment) => SEGMENT_RE.test(segment));
}

function requiredCompatibilityString(
  compat: Record<string, unknown>,
  key: (typeof COMPATIBILITY_STRING_FIELDS)[number],
  where: string,
): string {
  const value = compat[key];
  if (typeof value !== 'string' || !value) {
    parseFail(where, `compatibility.${key} must be a non-empty string`);
  }
  return value;
}

function parseVmstateCompatibility(
  value: unknown,
  where: string,
): VmstateCompatibility {
  if (!isPlainObject(value)) parseFail(where, 'has no "compatibility" object');
  if (value.vmstateFormat !== VMSTATE_FORMAT) {
    parseFail(
      where,
      `compatibility.vmstateFormat is "${String(value.vmstateFormat)}", expected "${VMSTATE_FORMAT}"`,
    );
  }
  return {
    platform: requiredCompatibilityString(value, 'platform', where),
    machinenRuntime: requiredCompatibilityString(value, 'machinenRuntime', where),
    vmstateFormat: VMSTATE_FORMAT,
    snapshotEngine: requiredCompatibilityString(value, 'snapshotEngine', where),
    reseed: requiredCompatibilityString(value, 'reseed', where),
    shell: parseVmstateShellIdentity(value.shell, where),
  };
}

function parseVmstateShellIdentity(value: unknown, where: string): VmstateShellIdentity {
  if (!isVmstateShellIdentity(value)) {
    parseFail(where, 'compatibility.shell must include rootfs/kernel digests as sha256:<hex>');
  }
  return value;
}

function parseVmstateFileEntry(
  entry: unknown,
  i: number,
  where: string,
): VmstateFileEntry {
  if (!isPlainObject(entry)) parseFail(where, `files[${i}] must be an object`);
  const { path: filePath, href, digest, bytes } = entry;
  if (typeof filePath !== 'string' || !isSafeBundlePath(filePath)) {
    parseFail(where, `files[${i}].path "${String(filePath)}" is not a safe relative path`);
  }
  if (typeof href !== 'string' || !href) parseFail(where, `files[${i}].href must be a non-empty string`);
  if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) {
    parseFail(where, `files[${i}].digest is not a sha256:<hex> digest`);
  }
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) {
    parseFail(where, `files[${i}].bytes must be a non-negative integer`);
  }
  return { path: filePath, href, digest, bytes };
}

function parseVmstateFiles(value: unknown, where: string): VmstateFileEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    parseFail(where, '"files" must be a non-empty array');
  }
  const files = value.map((entry, i) => parseVmstateFileEntry(entry, i, where));
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) parseFail(where, `has a duplicate file path "${file.path}"`);
    seen.add(file.path);
  }
  return files;
}

/** Validate untrusted bundle JSON into a typed manifest, or throw. */
export function parseVmstateBundleManifest(raw: string, where: string): VmstateBundleManifest {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    parseFail(where, 'is not valid JSON');
  }
  if (!isPlainObject(json)) parseFail(where, 'is not a JSON object');
  if (json.format !== VMSTATE_FORMAT) {
    parseFail(where, `has format "${String(json.format)}" (this consumer supports "${VMSTATE_FORMAT}")`);
  }
  if (typeof json.name !== 'string' || !json.name) parseFail(where, 'has no "name"');
  if (typeof json.createdAt !== 'string') parseFail(where, 'has no "createdAt"');
  const compatibility = parseVmstateCompatibility(json.compatibility, where);
  const files = parseVmstateFiles(json.files, where);
  return {
    format: VMSTATE_FORMAT,
    name: json.name,
    createdAt: json.createdAt,
    compatibility,
    files,
  };
}

/**
 * The installed @machinen/runtime version WITHOUT loading the (~18MB native)
 * runtime — resolve-time negotiation must work before any VMM exists.
 * Tries the package.json subpath first; falls back to walking up from the
 * resolved entry file when "exports" hides package.json.
 */
export function installedMachinenRuntimeVersion(): string | undefined {
  const require = createRequire(import.meta.url);
  try {
    const pkg = require('@machinen/runtime/package.json') as { version?: unknown };
    if (typeof pkg.version === 'string') return pkg.version;
  } catch {
    // ERR_PACKAGE_PATH_NOT_EXPORTED or not installed — try walking up.
  }
  try {
    let dir = path.dirname(require.resolve('@machinen/runtime'));
    for (;;) {
      try {
        const pkg = require(path.join(dir, 'package.json')) as {
          name?: unknown;
          version?: unknown;
        };
        if (pkg.name === '@machinen/runtime' && typeof pkg.version === 'string') {
          return pkg.version;
        }
      } catch {
        // no package.json at this level — keep walking
      }
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {
    return undefined;
  }
}

export interface VmstateHost {
  /** OCI-style platform of this host (ociHostPlatform()). */
  platform: string;
  /** Installed @machinen/runtime version. */
  machinenRuntime: string;
  /** Local MachineN shell identity available to restore this state. */
  shell: VmstateShellIdentity;
}

/**
 * The requiredVersion analog for hardware and runtime: a negotiation-style
 * message when the bundle cannot restore on this host, undefined when
 * compatible. Phase 2a is strict — exact platform, exact runtime version,
 * known snapshot engine. Loosening (semver ranges for the runtime) is a
 * Phase 2b decision once upstream documents vmstate stability.
 */
export function vmstateCompatibilityError(
  compat: VmstateCompatibility,
  host: VmstateHost,
): string | undefined {
  if (compat.platform !== host.platform) {
    return (
      `vmstate platform mismatch before download: artifact requires ` +
      `"${compat.platform}", this host is "${host.platform}"`
    );
  }
  if (compat.machinenRuntime !== host.machinenRuntime) {
    return (
      `vmstate requires @machinen/runtime ${compat.machinenRuntime}, installed ` +
      `${host.machinenRuntime}; refusing to restore an incompatible bundle`
    );
  }
  if (compat.snapshotEngine !== VMSTATE_SNAPSHOT_ENGINE) {
    return (
      `vmstate was dumped with unknown snapshot engine "${compat.snapshotEngine}" ` +
      `(this consumer supports "${VMSTATE_SNAPSHOT_ENGINE}")`
    );
  }
  if (!sameShell(compat.shell, host.shell)) {
    return (
      `vmstate shell mismatch before download: artifact requires ` +
      `${formatShell(compat.shell)}, this host has ${formatShell(host.shell)}`
    );
  }
  return undefined;
}

export function sameShell(a: VmstateShellIdentity, b: VmstateShellIdentity): boolean {
  return (
    a.rootfsDigest === b.rootfsDigest &&
    a.kernelDigest === b.kernelDigest &&
    a.dtbDigest === b.dtbDigest
  );
}

function formatShell(shell: VmstateShellIdentity): string {
  const dtb = shell.dtbDigest ? `, dtb=${shell.dtbDigest}` : '';
  return `rootfs=${shell.rootfsDigest}, kernel=${shell.kernelDigest}${dtb}`;
}

export interface CachedBlob {
  localPath: string;
  /** Bytes downloaded over the network (0 on a verified cache hit). */
  fetched: number;
}

export interface BlobFetchOptions {
  /** Deadline for the blob response headers. Default 30s. */
  fetchTimeoutMs?: number;
  /** Max stall between streamed body chunks. Default 30s. */
  streamIdleTimeoutMs?: number;
}

/** In-flight blob downloads by cache path — concurrent pulls of one digest
 * (two consumers of the same bundle in one process) join a single download. */
const inflightBlobs = new Map<string, Promise<CachedBlob>>();

function throwBlobError(message: string): never {
  throw new Error(message);
}

/**
 * Ensure a blob is in the content-addressed cache, streaming the download to
 * a temp file (multi-GB vmstate never fits in memory) and verifying the
 * digest before the blob becomes visible under its cache name. Built on the
 * shared blob-cache primitives: deadline-bounded fetch, idle-timeout-guarded
 * streaming, memoized cache-hit verification with quarantine eviction of
 * corrupt entries, and in-flight coalescing.
 */
export async function ensureBlobCached(
  url: string,
  entry: VmstateFileEntry,
  blobDir: string,
  opts: BlobFetchOptions = {},
): Promise<CachedBlob> {
  const hex = DIGEST_RE.exec(entry.digest)?.[1];
  if (!hex) throw new Error(`blob for "${entry.path}" has no valid sha256 digest ("${entry.digest}")`);
  await mkdir(blobDir, { recursive: true });
  const localPath = path.join(blobDir, hex);

  if (await verifyCachedFile(localPath, hex)) return { localPath, fetched: 0 };

  return coalesce(inflightBlobs, localPath, async (): Promise<CachedBlob> => {
    const fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const idleTimeoutMs = opts.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    // 'headers' scope: the body is a stream guarded by the idle timeout.
    const res = await fetchOkWith(url, 'blob', fetchTimeoutMs, 'headers', throwBlobError);
    const temp = tempCachePath(localPath);
    try {
      const { bytesFetched, hex: actual } = await streamHashedToTemp(res, temp, idleTimeoutMs, {
        noBody: () => new Error(`blob request to ${url} had no response body`),
        stalled: (ms) =>
          new Error(`blob download from ${url} stalled: no data for ${ms}ms (stream idle timeout)`),
        exceeded: (maxBytes) =>
          new Error(`blob download from ${url} exceeded advertised size ${maxBytes} bytes`),
      }, entry.bytes);
      if (actual !== hex) {
        throw new Error(
          `blob digest mismatch for "${entry.path}": expected sha256:${hex}, ` +
            `${url} served bytes hashing to sha256:${actual} — refusing to cache it`,
        );
      }
      await commitAtomic(temp, localPath, hex);
      return { localPath, fetched: bytesFetched };
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  });
}

/** Hardlink when possible (same fs, zero copy for 2.5GB blobs), copy otherwise. */
export async function linkOrCopy(source: string, dest: string): Promise<void> {
  try {
    await link(source, dest);
  } catch {
    await copyFile(source, dest);
  }
}

/**
 * Directory-level rename with the same concurrent-writer tolerance as the
 * file-level commitAtomic: content is digest-addressed, so a racer that
 * landed first materialized identical bytes — accept the existing dest.
 */
async function renameDirIntoPlace(temp: string, dest: string): Promise<void> {
  try {
    await rename(temp, dest);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    try {
      await stat(dest);
    } catch {
      throw error;
    }
  }
}

async function isMaterialized(manifest: VmstateBundleManifest, destDir: string): Promise<boolean> {
  for (const file of manifest.files) {
    const expected = DIGEST_RE.exec(file.digest)?.[1];
    if (!expected) return false;
    const target = path.join(destDir, ...file.path.split('/'));
    try {
      const info = await stat(target);
      if (!info.isFile() || info.size !== file.bytes) return false;
    } catch {
      return false;
    }
    if ((await sha256File(target)) !== expected) return false;
  }
  return true;
}

/**
 * Materialize a verified bundle as a driver-bootable snapshot directory.
 * Builds in a temp dir and renames into place so a half-built dir can never
 * boot; a complete existing dir (concurrent resolver, earlier pull) is
 * reused only when its files still match the bundle digests.
 */
export async function materializeVmstateDir(
  manifest: VmstateBundleManifest,
  blobPaths: string[],
  destDir: string,
): Promise<void> {
  if (await isMaterialized(manifest, destDir)) return;
  const temp = tempCachePath(destDir);
  try {
    for (const [i, file] of manifest.files.entries()) {
      const target = path.join(temp, ...file.path.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(blobPaths[i], target);
    }
    // A known-incomplete destination blocks rename (ENOTEMPTY) — clear it.
    await rm(destDir, { recursive: true, force: true });
    await renameDirIntoPlace(temp, destDir);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    if (await isMaterialized(manifest, destDir)) return; // lost a benign race
    throw error;
  }
}
