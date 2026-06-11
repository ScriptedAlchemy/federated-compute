import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

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

/** Safe relative bundle path: non-empty slash-joined SEGMENT_RE segments. */
export function isSafeBundlePath(candidate: string): boolean {
  if (!candidate || candidate.length > 512) return false;
  return candidate.split('/').every((segment) => SEGMENT_RE.test(segment));
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
  const compat = json.compatibility;
  if (!isPlainObject(compat)) parseFail(where, 'has no "compatibility" object');
  for (const key of ['platform', 'machinenRuntime', 'snapshotEngine', 'reseed'] as const) {
    if (typeof compat[key] !== 'string' || !compat[key]) {
      parseFail(where, `compatibility.${key} must be a non-empty string`);
    }
  }
  if (compat.vmstateFormat !== VMSTATE_FORMAT) {
    parseFail(
      where,
      `compatibility.vmstateFormat is "${String(compat.vmstateFormat)}", expected "${VMSTATE_FORMAT}"`,
    );
  }
  if (!Array.isArray(json.files) || json.files.length === 0) {
    parseFail(where, '"files" must be a non-empty array');
  }
  const files: VmstateFileEntry[] = json.files.map((entry, i) => {
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
  });
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) parseFail(where, `has a duplicate file path "${file.path}"`);
    seen.add(file.path);
  }
  return {
    format: VMSTATE_FORMAT,
    name: json.name,
    createdAt: json.createdAt,
    compatibility: {
      platform: compat.platform as string,
      machinenRuntime: compat.machinenRuntime as string,
      vmstateFormat: VMSTATE_FORMAT,
      snapshotEngine: compat.snapshotEngine as string,
      reseed: compat.reseed as string,
    },
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
  return undefined;
}
