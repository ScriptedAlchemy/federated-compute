# Vmstate Federation Phase 2a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A machine running as a real microVM can be published by its own plugin (`plugin.publishMachine()` + a lazily started, plugin-owned artifact endpoint) and pulled by another host's `machinen+pull+http://...?artifact=vmstate` entry, which restores the whole VM through the existing `machinenDriver()` snapshot-dir boot — fork-by-pull as an MF-plugin primitive.

**Architecture:** One shared format module (`src/vmstate.ts`) defines `machinen-vmstate@1` bundle manifests (per-file sha256 digests, OCI platform vocabulary, compatibility preflight) plus the streaming content-addressed blob cache and snapshot-dir materialization. The consumer side extends `resolvePullEntry()` in `src/artifacts.ts` with a third artifact kind that rewrites the spec to a local snapshot-dir `kind: 'image'` boot — `machinenDriver().boot()` already restores those, so no driver changes. The producer side is `src/publish.ts`: `publishSnapshotDir()` writes a content-addressed layout, `startArtifactEndpoint()` serves it read-only over loopback HTTP with Range support, and `plugin.publishMachine()` (new lifecycle verb, with `beforePublish`/`onPublished` hooks) wires both behind plugin options. The user-facing surface stays exactly MF runtime + `machinenPlugin()` + entries + lifecycle verbs.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, pnpm workspace, node:http/node:crypto/node:stream only (no new dependencies). Spec: `docs/superpowers/specs/2026-06-11-image-federation-phase2-design.md` (plugin-centric revision).

**Conventions:** Run all package commands from `packages/runtime-plugin` unless noted. Tests follow the existing style in `packages/runtime-plugin/test/*.test.ts` (vitest; hand-rolled `node:http` stub origins as in `test/artifacts.test.ts`; honest-skip real-VM suites as in `test/machinen-driver.test.ts`). `@machinen/runtime@0.4.0` is a devDependency of this package, so `installedMachinenRuntimeVersion()` returns `"0.4.0"` in tests without loading the native runtime.

**Explicitly deferred to Phase 2b/2c (do NOT build here):** resumable/`Range` *downloads* on the consumer (the endpoint serves ranges; the resolver downloads whole blobs streamed to disk), download progress hooks, producer/consumer GC policies, compression, a registry/CDN tier beyond "copy the layout to static hosting", auto-publish on schedule or on `snapshotMachine()`, endpoint start at `warm()` time (2a starts it on first publish), multi-version artifact selection, the `scripts/demo-vmstate-pull.mjs` demo, docs updates (`guest-protocol.md`, `machinen-driver.md`, `operators.md`), the `artifactFetchTimeoutMs`/`bootTimeoutMs` split (real-VM tasks raise `bootTimeoutMs` instead), and `.github/workflows/machinen.yml` wiring for the new real-VM test.

**Plan-level deviations from the spec (forced by the code as it stands, b867e5e):**

1. Bundle-manifest `href`s are **machine-base-relative** (`blobs/sha256/<hex>`, `vmstate/<bundle>/bundle.json`), not the spec example's `../../`-relative form — `joinArtifactUrl()` is a deliberate base-prefix join with no dot-segment semantics.
2. `compatibility` lives **only in `bundle.json`**, not duplicated on the `ArtifactDescriptor` — the descriptor keeps its existing shape (its `platform` field still gates before the bundle fetch) and the bundle manifest is the single source of truth, fetched before any blob bytes move.
3. `?digest=` on a vmstate pull pins **the bundle digest** (sha256 of the served `bundle.json` bytes). b867e5e gave each artifact kind pin semantics over its immutable identity (image pulls pin the image, snapshot pulls pin the referenced image); vmstate follows: the bundle manifest is the immutable identity.
4. `guestMemoryMiB`/`guestPort` are **not** in the compatibility block: `federated-machine.json` (the marker the driver already writes and reads via `resolveGuestPort()`) travels as an ordinary bundle file, and `bootFromSnapshot()` deliberately passes no memory override (the vmstate dictates it). `compression`/`role` fields are dropped — uniformly `none`/informational in 2a.
5. OCI platform vocabulary (`linux/amd64`) applies **only to vmstate**; Phase 1's `checkPlatform()` (Node-style `linux/x64`, `any`) is untouched so existing artifacts keep working.
6. `publishMachine()` emits `beforeSnapshot`/`onSnapshotted` in addition to the new `beforePublish`/`onPublished` — it drives `handle.snapshot()`, and existing hook consumers must keep seeing snapshots.
7. The published `mf-manifest.json` carries **only** `artifacts.vmstate` (guest `image`/`snapshot` descriptors are dropped: the layout does not serve `/mf-image`//`/mf-snapshot`, and advertising them would 404).
8. `ResolvePullOptions` gains `machinenRuntimeVersion?: string` — a test/ops override; the default reads the installed `@machinen/runtime` `package.json` without loading the ~18MB native runtime.

---

### Task 1: `machinen-vmstate@1` bundle format (`src/vmstate.ts`)

**Files:**
- Create: `packages/runtime-plugin/src/vmstate.ts`
- Test: `packages/runtime-plugin/test/vmstate.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/runtime-plugin/test/vmstate.test.ts
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  VMSTATE_FORMAT,
  buildVmstateBundle,
  ociHostPlatform,
  parseVmstateBundleManifest,
  sha256File,
  type VmstateCompatibility,
} from '../src/vmstate.js';

const COMPAT: VmstateCompatibility = {
  platform: 'linux/amd64',
  machinenRuntime: '0.4.0',
  vmstateFormat: VMSTATE_FORMAT,
  snapshotEngine: 'machinen-default',
  reseed: 'machinen-0.4.0-shim@1',
};

function hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fakeSnapshotDir(): Promise<{ dir: string; files: Record<string, Buffer> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vmstate-snap-'));
  const files = {
    'meta.json': Buffer.from('{"machinen":"meta"}'),
    'state.vmstate': Buffer.from('fake-vm-ram-and-disk-'.repeat(1000)),
    'federated-machine.json': Buffer.from(
      JSON.stringify({ remoteName: 'vm_machine', guestPort: 3801, image: 'base.tar.gz', snappedAt: 'now' }),
    ),
  };
  for (const [name, bytes] of Object.entries(files)) {
    await writeFile(path.join(dir, name), bytes);
  }
  return { dir, files };
}

describe('ociHostPlatform', () => {
  test('maps node arch to OCI vocabulary', () => {
    const platform = ociHostPlatform();
    expect(platform).toBe(
      `${process.platform}/${process.arch === 'x64' ? 'amd64' : process.arch}`,
    );
    expect(platform).not.toContain('x64');
  });
});

describe('buildVmstateBundle', () => {
  test('hashes every file of a snapshot dir into sorted, digest-true entries', async () => {
    const { dir, files } = await fakeSnapshotDir();
    const built = await buildVmstateBundle(dir, { name: 'vm_machine', compatibility: COMPAT });

    expect(built.manifest.format).toBe(VMSTATE_FORMAT);
    expect(built.manifest.name).toBe('vm_machine');
    expect(built.manifest.compatibility).toEqual(COMPAT);
    expect(built.manifest.files.map((f) => f.path)).toEqual([
      'federated-machine.json',
      'meta.json',
      'state.vmstate',
    ]);
    for (const entry of built.manifest.files) {
      const bytes = files[entry.path];
      expect(entry.digest).toBe(`sha256:${hex(bytes)}`);
      expect(entry.bytes).toBe(bytes.length);
      expect(entry.href).toBe(`blobs/sha256/${hex(bytes)}`);
    }
    // sources line up with manifest.files, same order.
    expect(built.sources).toEqual(built.manifest.files.map((f) => path.join(dir, f.path)));
  });

  test('walks nested directories', async () => {
    const { dir } = await fakeSnapshotDir();
    await mkdir(path.join(dir, 'extra'), { recursive: true });
    await writeFile(path.join(dir, 'extra', 'disk.img'), 'nested');
    const built = await buildVmstateBundle(dir, { name: 'vm_machine', compatibility: COMPAT });
    expect(built.manifest.files.map((f) => f.path)).toContain('extra/disk.img');
  });

  test('rejects an empty snapshot dir', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vmstate-empty-'));
    await expect(
      buildVmstateBundle(dir, { name: 'vm_machine', compatibility: COMPAT }),
    ).rejects.toThrow(/contains no files/);
  });
});

describe('sha256File', () => {
  test('streams a file to its hex digest', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vmstate-hash-'));
    const file = path.join(dir, 'blob');
    await writeFile(file, 'digest me');
    expect(await sha256File(file)).toBe(hex('digest me'));
  });
});

describe('parseVmstateBundleManifest', () => {
  function valid(): Record<string, unknown> {
    return {
      format: VMSTATE_FORMAT,
      name: 'vm_machine',
      createdAt: new Date().toISOString(),
      compatibility: { ...COMPAT },
      files: [
        { path: 'meta.json', href: 'blobs/sha256/aa', digest: `sha256:${'a'.repeat(64)}`, bytes: 2 },
      ],
    };
  }

  test('round-trips a valid manifest', () => {
    const parsed = parseVmstateBundleManifest(JSON.stringify(valid()), 'at test://bundle');
    expect(parsed.name).toBe('vm_machine');
    expect(parsed.files).toHaveLength(1);
  });

  test.each([
    [{ format: 'oci-layout@7' }, /format "oci-layout@7"/],
    [{ name: '' }, /"name"/],
    [{ compatibility: undefined }, /"compatibility"/],
    [{ files: [] }, /"files" must be a non-empty array/],
  ])('rejects %j', (patch, message) => {
    expect(() =>
      parseVmstateBundleManifest(JSON.stringify({ ...valid(), ...patch }), 'at test://bundle'),
    ).toThrow(message);
  });

  test('rejects path traversal and absolute paths in file entries', () => {
    for (const evil of ['../../etc/passwd', '/etc/passwd', 'a/../b', 'a\\b', '..']) {
      const manifest = valid();
      (manifest.files as { path: string }[])[0].path = evil;
      expect(() =>
        parseVmstateBundleManifest(JSON.stringify(manifest), 'at test://bundle'),
      ).toThrow(/not a safe relative path/);
    }
  });

  test('rejects duplicate file paths', () => {
    const manifest = valid();
    (manifest.files as unknown[]).push((manifest.files as unknown[])[0]);
    expect(() =>
      parseVmstateBundleManifest(JSON.stringify(manifest), 'at test://bundle'),
    ).toThrow(/duplicate file path/);
  });

  test('rejects invalid digests and negative sizes', () => {
    const badDigest = valid();
    (badDigest.files as { digest: string }[])[0].digest = 'md5:abc';
    expect(() =>
      parseVmstateBundleManifest(JSON.stringify(badDigest), 'at test://bundle'),
    ).toThrow(/digest/);

    const badBytes = valid();
    (badBytes.files as { bytes: number }[])[0].bytes = -1;
    expect(() =>
      parseVmstateBundleManifest(JSON.stringify(badBytes), 'at test://bundle'),
    ).toThrow(/bytes/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/vmstate.test.ts` (in `packages/runtime-plugin`)
Expected: FAIL — `Cannot find module '../src/vmstate.js'`

- [ ] **Step 3: Implement `src/vmstate.ts`**

```ts
// packages/runtime-plugin/src/vmstate.ts
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/vmstate.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-plugin/src/vmstate.ts packages/runtime-plugin/test/vmstate.test.ts
git commit -m "Add machinen-vmstate@1 bundle format: build, hash, and validate snapshot-dir manifests"
```

---

### Task 2: Compatibility preflight — the requiredVersion analog for hardware

**Files:**
- Modify: `packages/runtime-plugin/src/vmstate.ts` (append)
- Test: `packages/runtime-plugin/test/vmstate.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `packages/runtime-plugin/test/vmstate.test.ts` (merge the import into the existing import block at the top of the file):

```ts
import {
  installedMachinenRuntimeVersion,
  vmstateCompatibilityError,
} from '../src/vmstate.js';

describe('vmstateCompatibilityError', () => {
  const host = { platform: 'linux/amd64', machinenRuntime: '0.4.0' };

  test('compatible bundle returns undefined', () => {
    expect(vmstateCompatibilityError(COMPAT, host)).toBeUndefined();
  });

  test('platform mismatch names both platforms', () => {
    const message = vmstateCompatibilityError(
      { ...COMPAT, platform: 'linux/arm64' },
      host,
    );
    expect(message).toMatch(/requires "linux\/arm64".*this host is "linux\/amd64"/s);
    expect(message).toMatch(/before download/);
  });

  test('runtime mismatch names both versions', () => {
    const message = vmstateCompatibilityError(
      { ...COMPAT, machinenRuntime: '0.5.1' },
      host,
    );
    expect(message).toMatch(/requires @machinen\/runtime 0\.5\.1.*installed 0\.4\.0/s);
  });

  test('unknown snapshot engine is rejected by name', () => {
    const message = vmstateCompatibilityError(
      { ...COMPAT, snapshotEngine: 'criu-experimental' },
      host,
    );
    expect(message).toMatch(/"criu-experimental"/);
  });
});

describe('installedMachinenRuntimeVersion', () => {
  test('reads the devDependency version without loading the native runtime', () => {
    // @machinen/runtime@0.4.0 is a devDependency of this package.
    expect(installedMachinenRuntimeVersion()).toBe('0.4.0');
  });
});
```

- [ ] **Step 2: Run tests to verify the new block fails**

Run: `pnpm vitest run test/vmstate.test.ts`
Expected: new tests FAIL (`vmstateCompatibilityError` not exported); Task 1 tests PASS.

- [ ] **Step 3: Implement in `src/vmstate.ts`**

Add to the import block at the top of the file:

```ts
import { createRequire } from 'node:module';
```

Append:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/vmstate.test.ts`
Expected: PASS (15 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-plugin/src/vmstate.ts packages/runtime-plugin/test/vmstate.test.ts
git commit -m "Add vmstate compatibility preflight: OCI platform, exact runtime version, known engine"
```

---

### Task 3: Streaming content-addressed blob cache + materialization

**Files:**
- Modify: `packages/runtime-plugin/src/vmstate.ts` (append)
- Test: `packages/runtime-plugin/test/vmstate.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `packages/runtime-plugin/test/vmstate.test.ts` (merge imports; the http/afterAll imports join the existing top-of-file blocks):

```ts
import http from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { afterAll } from 'vitest';
import {
  ensureBlobCached,
  materializeVmstateDir,
} from '../src/vmstate.js';

const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.all(closers.map((close) => close()));
});

async function serveBytes(routes: Record<string, Buffer>): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    const body = routes[req.url ?? ''];
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(body);
  });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
  );
  closers.push(() => new Promise((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${port}`, requests };
}

function entryFor(filePath: string, bytes: Buffer) {
  return {
    path: filePath,
    href: `blobs/sha256/${hex(bytes)}`,
    digest: `sha256:${hex(bytes)}`,
    bytes: bytes.length,
  };
}

describe('ensureBlobCached', () => {
  test('streams a download into the digest-named cache file', async () => {
    const bytes = Buffer.from('vmstate-blob-'.repeat(500));
    const origin = await serveBytes({ '/blob': bytes });
    const blobDir = await mkdtemp(path.join(os.tmpdir(), 'vmstate-blobs-'));

    const cached = await ensureBlobCached(`${origin.url}/blob`, entryFor('state.vmstate', bytes), blobDir);
    expect(cached.fetched).toBe(bytes.length);
    expect(cached.localPath).toBe(path.join(blobDir, hex(bytes)));
    expect(await readFile(cached.localPath)).toEqual(bytes);
    // no stray .partial files
    expect(readdirSync(blobDir)).toEqual([hex(bytes)]);
  });

  test('verified cache hit never touches the network', async () => {
    const bytes = Buffer.from('hit me');
    const origin = await serveBytes({ '/blob': bytes });
    const blobDir = await mkdtemp(path.join(os.tmpdir(), 'vmstate-blobs-'));
    await ensureBlobCached(`${origin.url}/blob`, entryFor('meta.json', bytes), blobDir);

    const again = await ensureBlobCached(`${origin.url}/blob`, entryFor('meta.json', bytes), blobDir);
    expect(again.fetched).toBe(0);
    expect(origin.requests.filter((r) => r === '/blob')).toHaveLength(1);
  });

  test('a corrupt cache entry is evicted and re-downloaded', async () => {
    const bytes = Buffer.from('correct bytes');
    const origin = await serveBytes({ '/blob': bytes });
    const blobDir = await mkdtemp(path.join(os.tmpdir(), 'vmstate-blobs-'));
    await writeFile(path.join(blobDir, hex(bytes)), 'corrupted');

    const cached = await ensureBlobCached(`${origin.url}/blob`, entryFor('meta.json', bytes), blobDir);
    expect(cached.fetched).toBe(bytes.length);
    expect(await readFile(cached.localPath)).toEqual(bytes);
  });

  test('a digest mismatch fails closed and caches nothing', async () => {
    const bytes = Buffer.from('expected bytes');
    const origin = await serveBytes({ '/blob': Buffer.from('tampered bytes') });
    const blobDir = await mkdtemp(path.join(os.tmpdir(), 'vmstate-blobs-'));

    await expect(
      ensureBlobCached(`${origin.url}/blob`, entryFor('state.vmstate', bytes), blobDir),
    ).rejects.toThrow(/digest mismatch.*state\.vmstate/s);
    expect(readdirSync(blobDir)).toEqual([]);
  });

  test('an unreachable origin names the URL', async () => {
    const bytes = Buffer.from('x');
    const blobDir = await mkdtemp(path.join(os.tmpdir(), 'vmstate-blobs-'));
    await expect(
      ensureBlobCached('http://127.0.0.1:1/blob', entryFor('meta.json', bytes), blobDir),
    ).rejects.toThrow(/127\.0\.0\.1:1/);
  });
});

describe('materializeVmstateDir', () => {
  async function builtFixture() {
    const { dir } = await fakeSnapshotDir();
    const built = await buildVmstateBundle(dir, { name: 'vm_machine', compatibility: COMPAT });
    // copy sources into a fake blob cache, digest-named
    const blobDir = await mkdtemp(path.join(os.tmpdir(), 'vmstate-blobs-'));
    const blobPaths: string[] = [];
    for (const [i, file] of built.manifest.files.entries()) {
      const target = path.join(blobDir, file.digest.slice('sha256:'.length));
      await writeFile(target, await readFile(built.sources[i]));
      blobPaths.push(target);
    }
    return { built, blobPaths, sourceDir: dir };
  }

  test('links/copies blobs into a complete snapshot dir', async () => {
    const { built, blobPaths, sourceDir } = await builtFixture();
    const dest = path.join(await mkdtemp(path.join(os.tmpdir(), 'vmstate-mat-')), 'snap');

    await materializeVmstateDir(built.manifest, blobPaths, dest);
    for (const file of built.manifest.files) {
      expect(await readFile(path.join(dest, file.path))).toEqual(
        await readFile(path.join(sourceDir, file.path)),
      );
    }
    // no temp dirs left behind
    expect(readdirSync(path.dirname(dest)).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  test('an already-materialized dir is reused untouched', async () => {
    const { built, blobPaths } = await builtFixture();
    const dest = path.join(await mkdtemp(path.join(os.tmpdir(), 'vmstate-mat-')), 'snap');
    await materializeVmstateDir(built.manifest, blobPaths, dest);
    const marker = path.join(dest, 'made-by-first-call');
    await writeFile(marker, 'untouched');

    await materializeVmstateDir(built.manifest, blobPaths, dest);
    expect(existsSync(marker)).toBe(true);
  });

  test('a half-built destination (wrong sizes) is rebuilt', async () => {
    const { built, blobPaths } = await builtFixture();
    const dest = path.join(await mkdtemp(path.join(os.tmpdir(), 'vmstate-mat-')), 'snap');
    await materializeVmstateDir(built.manifest, blobPaths, dest);
    await rm(path.join(dest, 'state.vmstate'));

    await materializeVmstateDir(built.manifest, blobPaths, dest);
    expect(existsSync(path.join(dest, 'state.vmstate'))).toBe(true);
  });
});
```

Note: the rebuilt-destination case renames a fresh temp dir onto a non-empty `dest`, which `rename(2)` refuses (`ENOTEMPTY`). The implementation below removes a known-incomplete destination before renaming — that is what this test pins.

- [ ] **Step 2: Run tests to verify the new blocks fail**

Run: `pnpm vitest run test/vmstate.test.ts`
Expected: new tests FAIL (`ensureBlobCached`/`materializeVmstateDir` not exported); earlier tests PASS.

- [ ] **Step 3: Implement in `src/vmstate.ts`**

Extend the import block at the top of the file:

```ts
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, link, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
```

Append:

```ts
export interface CachedBlob {
  localPath: string;
  /** Bytes downloaded over the network (0 on a verified cache hit). */
  fetched: number;
}

/**
 * rename with the same concurrent-writer tolerance as artifacts.writeAtomic:
 * content is digest-addressed, so a racer that landed first wrote identical
 * bytes — accept the existing destination.
 */
async function renameIntoPlace(temp: string, dest: string): Promise<void> {
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

/**
 * Ensure a blob is in the content-addressed cache, streaming the download to
 * a .partial file (multi-GB vmstate never fits in memory) and verifying the
 * digest before the blob becomes visible under its cache name. Cache hits
 * are re-hashed before reuse (Phase 1 precedent; a verified-marker index is
 * a Phase 2b optimization).
 */
export async function ensureBlobCached(
  url: string,
  entry: VmstateFileEntry,
  blobDir: string,
): Promise<CachedBlob> {
  const hex = DIGEST_RE.exec(entry.digest)?.[1];
  if (!hex) throw new Error(`blob for "${entry.path}" has no valid sha256 digest ("${entry.digest}")`);
  await mkdir(blobDir, { recursive: true });
  const localPath = path.join(blobDir, hex);

  try {
    if ((await sha256File(localPath)) === hex) return { localPath, fetched: 0 };
    await rm(localPath, { force: true });
  } catch {
    // absent — download below
  }

  let res: Response;
  try {
    res = await fetch(url);
  } catch (error) {
    throw new Error(`blob request to ${url} failed: ${(error as Error).message}`);
  }
  if (!res.ok || !res.body) {
    throw new Error(`blob request to ${url} answered ${res.status}`);
  }

  const partial = `${localPath}.partial-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const hash = createHash('sha256');
  let fetched = 0;
  try {
    await pipeline(
      Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
      async function* (source) {
        for await (const chunk of source) {
          const bytes = chunk as Buffer;
          hash.update(bytes);
          fetched += bytes.length;
          yield bytes;
        }
      },
      createWriteStream(partial),
    );
    const actual = hash.digest('hex');
    if (actual !== hex) {
      throw new Error(
        `blob digest mismatch for "${entry.path}": expected sha256:${hex}, ` +
          `${url} served bytes hashing to sha256:${actual} — refusing to cache it`,
      );
    }
    await renameIntoPlace(partial, localPath);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return { localPath, fetched };
}

/** Hardlink when possible (same fs, zero copy for 2.5GB blobs), copy otherwise. */
export async function linkOrCopy(source: string, dest: string): Promise<void> {
  try {
    await link(source, dest);
  } catch {
    await copyFile(source, dest);
  }
}

async function isMaterialized(manifest: VmstateBundleManifest, destDir: string): Promise<boolean> {
  for (const file of manifest.files) {
    try {
      const info = await stat(path.join(destDir, ...file.path.split('/')));
      if (!info.isFile() || info.size !== file.bytes) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Materialize a verified bundle as a driver-bootable snapshot directory.
 * Builds in a temp dir and renames into place so a half-built dir can never
 * boot; a complete existing dir (concurrent resolver, earlier pull) is
 * reused as-is. Blob bytes were digest-verified by ensureBlobCached, so the
 * completeness check here is existence + size.
 */
export async function materializeVmstateDir(
  manifest: VmstateBundleManifest,
  blobPaths: string[],
  destDir: string,
): Promise<void> {
  if (await isMaterialized(manifest, destDir)) return;
  const temp = `${destDir}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    for (const [i, file] of manifest.files.entries()) {
      const target = path.join(temp, ...file.path.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await linkOrCopy(blobPaths[i], target);
    }
    // A known-incomplete destination blocks rename (ENOTEMPTY) — clear it.
    await rm(destDir, { recursive: true, force: true });
    await renameIntoPlace(temp, destDir);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    if (await isMaterialized(manifest, destDir)) return; // lost a benign race
    throw error;
  }
}
```

(`readdir` joins the import list now; `buildVmstateBundle` already uses it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/vmstate.test.ts`
Expected: PASS (23 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-plugin/src/vmstate.ts packages/runtime-plugin/test/vmstate.test.ts
git commit -m "Stream vmstate blobs into a content-addressed cache and materialize bootable snapshot dirs"
```

---

### Task 4: Consumer resolver — `?artifact=vmstate` in `resolvePullEntry()`

**Files:**
- Modify: `packages/runtime-plugin/src/types.ts` (the `artifacts` block, ~line 78-83)
- Modify: `packages/runtime-plugin/src/artifacts.ts` (`PullArtifactKind` line 29, `ResolvePullOptions` line 45-48, `selectArtifact` line 217-223, new `resolveVmstate`, the switch in `resolvePullEntry` line 421-431)
- Test: `packages/runtime-plugin/test/vmstate-resolver.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/runtime-plugin/test/vmstate-resolver.test.ts
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { resolvePullEntry } from '../src/artifacts.js';
import { isMachinenSnapshotDir } from '../src/drivers/machinen.js';
import { parseMachineEntry } from '../src/types.js';
import { VMSTATE_FORMAT, ociHostPlatform, type VmstateCompatibility } from '../src/vmstate.js';

function hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const FILES: Record<string, Buffer> = {
  'meta.json': Buffer.from('{"machinen":"meta"}'),
  'state.vmstate': Buffer.from('vm-ram-'.repeat(2000)),
  'federated-machine.json': Buffer.from(
    JSON.stringify({ remoteName: 'vm_origin', guestPort: 3801, image: 'base.tar.gz', snappedAt: 'now' }),
  ),
};

const HOST_RUNTIME = '0.4.0';

function makeBundle(compat: Partial<VmstateCompatibility> = {}) {
  const files = Object.entries(FILES).map(([filePath, bytes]) => ({
    path: filePath,
    href: `blobs/sha256/${hex(bytes)}`,
    digest: `sha256:${hex(bytes)}`,
    bytes: bytes.length,
  }));
  const manifest = {
    format: VMSTATE_FORMAT,
    name: 'vm_origin',
    createdAt: new Date().toISOString(),
    compatibility: {
      platform: ociHostPlatform(),
      machinenRuntime: HOST_RUNTIME,
      vmstateFormat: VMSTATE_FORMAT,
      snapshotEngine: 'machinen-default',
      reseed: 'machinen-0.4.0-shim@1',
      ...compat,
    },
    files,
  };
  const json = JSON.stringify(manifest);
  return { json, digest: `sha256:${hex(json)}` };
}

interface StubOrigin {
  url: string;
  requests: string[];
  close(): Promise<void>;
}

const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.all(closers.map((close) => close()));
});

/** A vmstate origin: machine manifest + bundle.json + blobs, with a request log. */
async function startVmstateOrigin(
  bundle: { json: string; digest: string },
  opts: { blobs?: Record<string, Buffer>; descriptorPlatform?: string } = {},
): Promise<StubOrigin> {
  const requests: string[] = [];
  const blobs = opts.blobs ?? FILES;
  const manifest = {
    name: 'vm_origin',
    protocol: 3,
    version: '1.0.0',
    artifacts: {
      vmstate: {
        href: `vmstate/${bundle.digest.replace(':', '-')}/bundle.json`,
        format: VMSTATE_FORMAT,
        digest: bundle.digest,
        bytes: Object.values(blobs).reduce((sum, b) => sum + b.length, 0),
        platform: opts.descriptorPlatform ?? ociHostPlatform(),
      },
    },
    exposes: { './counter': { increment: { params: [], returns: 'number' } } },
  };
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    requests.push(url);
    if (url === '/mf-manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(manifest));
      return;
    }
    if (url === `/vmstate/${bundle.digest.replace(':', '-')}/bundle.json`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(bundle.json);
      return;
    }
    const blobMatch = /^\/blobs\/sha256\/([a-f0-9]{64})$/.exec(url);
    if (blobMatch) {
      const body = Object.values(blobs).find((bytes) => hex(bytes) === blobMatch[1]);
      if (body) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(body);
        return;
      }
    }
    res.writeHead(404);
    res.end();
  });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
  );
  const origin = {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  closers.push(origin.close);
  return origin;
}

let cacheDir: string;
beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(os.tmpdir(), 'vmstate-cache-'));
});

function pullSpec(url: string, query = '?artifact=vmstate') {
  return parseMachineEntry('vm_origin', `machinen+pull+${url}${query}`);
}

const RESOLVE = { machinenRuntimeVersion: HOST_RUNTIME };

describe('resolvePullEntry: vmstate artifacts', () => {
  test('downloads blobs, materializes a snapshot dir, and rewrites the spec for restore', async () => {
    const bundle = makeBundle();
    const origin = await startVmstateOrigin(bundle);

    const resolution = await resolvePullEntry(pullSpec(origin.url), { cacheDir, ...RESOLVE });

    expect(resolution.artifact).toBe('vmstate');
    expect(resolution.localPath).toBe(
      path.join(cacheDir, 'vmstate', bundle.digest.replace(':', '-')),
    );
    expect(await isMachinenSnapshotDir(resolution.localPath)).toBe(true);
    for (const [name, bytes] of Object.entries(FILES)) {
      expect(await readFile(path.join(resolution.localPath, name))).toEqual(bytes);
    }
    expect(resolution.spec.kind).toBe('image');
    expect(resolution.spec.image).toBe(resolution.localPath);
    expect(resolution.spec.pulledFrom).toContain('machinen+pull+');
    expect(resolution.bytesFetched).toBe(
      Object.values(FILES).reduce((sum, b) => sum + b.length, 0),
    );
    expect(resolution.fromCache).toBe(false);
  });

  test('a second pull is a full cache hit: no blob downloads', async () => {
    const bundle = makeBundle();
    const origin = await startVmstateOrigin(bundle);
    await resolvePullEntry(pullSpec(origin.url), { cacheDir, ...RESOLVE });

    const second = await resolvePullEntry(pullSpec(origin.url), { cacheDir, ...RESOLVE });
    expect(second.fromCache).toBe(true);
    expect(second.bytesFetched).toBe(0);
    expect(origin.requests.filter((r) => r.startsWith('/blobs/'))).toHaveLength(
      Object.keys(FILES).length,
    );
  });

  test('cross-platform bundles are rejected at the descriptor, before even bundle.json', async () => {
    const bundle = makeBundle();
    const origin = await startVmstateOrigin(bundle, { descriptorPlatform: 'linux/never-arch' });

    await expect(
      resolvePullEntry(pullSpec(origin.url), { cacheDir, ...RESOLVE }),
    ).rejects.toThrow(/requires "linux\/never-arch"/);
    expect(origin.requests).toEqual(['/mf-manifest.json']);
  });

  test('a bundle-level platform mismatch is rejected before any blob moves', async () => {
    // Descriptor lies "compatible"; the authoritative bundle says otherwise.
    const bundle = makeBundle({ platform: 'linux/never-arch' });
    const origin = await startVmstateOrigin(bundle);

    await expect(
      resolvePullEntry(pullSpec(origin.url), { cacheDir, ...RESOLVE }),
    ).rejects.toThrow(/requires "linux\/never-arch"/);
    expect(origin.requests.filter((r) => r.startsWith('/blobs/'))).toHaveLength(0);
  });

  test('a machinen runtime mismatch names both versions and downloads nothing', async () => {
    const bundle = makeBundle({ machinenRuntime: '0.5.1' });
    const origin = await startVmstateOrigin(bundle);

    await expect(
      resolvePullEntry(pullSpec(origin.url), { cacheDir, ...RESOLVE }),
    ).rejects.toThrow(/requires @machinen\/runtime 0\.5\.1.*installed 0\.4\.0/s);
    expect(origin.requests.filter((r) => r.startsWith('/blobs/'))).toHaveLength(0);
  });

  test('a tampered bundle manifest (digest mismatch) fails closed', async () => {
    const bundle = makeBundle();
    const lying = { json: `${bundle.json} `, digest: bundle.digest }; // bytes differ from digest
    const origin = await startVmstateOrigin(lying);

    await expect(
      resolvePullEntry(pullSpec(origin.url), { cacheDir, ...RESOLVE }),
    ).rejects.toThrow(/bundle manifest digest mismatch/);
  });

  test('a tampered blob fails closed and caches nothing under its name', async () => {
    const bundle = makeBundle();
    const tampered = { ...FILES, 'state.vmstate': Buffer.from('not the advertised bytes') };
    const origin = await startVmstateOrigin(bundle, { blobs: tampered });

    await expect(
      resolvePullEntry(pullSpec(origin.url), { cacheDir, ...RESOLVE }),
    ).rejects.toThrow(/digest mismatch/);
    const blobDir = path.join(cacheDir, 'blobs', 'sha256');
    expect(
      existsSync(path.join(blobDir, hex(FILES['state.vmstate']))),
    ).toBe(false);
    // the materialized dir must not exist either
    expect(existsSync(path.join(cacheDir, 'vmstate', bundle.digest.replace(':', '-')))).toBe(false);
  });

  test('?digest= pins the bundle digest', async () => {
    const bundle = makeBundle();
    const origin = await startVmstateOrigin(bundle);
    const wrong = `sha256:${'b'.repeat(64)}`;

    await expect(
      resolvePullEntry(pullSpec(origin.url, `?artifact=vmstate&digest=${wrong}`), {
        cacheDir,
        ...RESOLVE,
      }),
    ).rejects.toThrow(/pins digest/);

    const pinned = await resolvePullEntry(
      pullSpec(origin.url, `?artifact=vmstate&digest=${bundle.digest}`),
      { cacheDir, ...RESOLVE },
    );
    expect(pinned.artifact).toBe('vmstate');
  });

  test('?version= is negotiated against the origin manifest before the bundle fetch', async () => {
    const bundle = makeBundle();
    const origin = await startVmstateOrigin(bundle);

    await expect(
      resolvePullEntry(pullSpec(origin.url, '?artifact=vmstate&version=^2.0.0'), {
        cacheDir,
        ...RESOLVE,
      }),
    ).rejects.toThrow(/version/i);
    expect(origin.requests).toEqual(['/mf-manifest.json']);
  });

  test('machines without a vmstate artifact name the gap and suggest attaching', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'bare', protocol: 3, version: '1.0.0', exposes: {} }));
    });
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
    );
    closers.push(() => new Promise((r) => server.close(() => r())));

    await expect(
      resolvePullEntry(pullSpec(`http://127.0.0.1:${port}`), { cacheDir, ...RESOLVE }),
    ).rejects.toThrow(/publishes no "vmstate" artifact.*attach/s);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/vmstate-resolver.test.ts`
Expected: FAIL — `unknown ?artifact= value "vmstate"`.

- [ ] **Step 3: Add `vmstate` to the manifest artifacts block in `src/types.ts`**

```ts
  artifacts?: {
    /** The machine's program — the remoteEntry.js analog. */
    image?: ArtifactDescriptor;
    /** A freshly dehydrated warm snapshot (state + image digest reference). */
    snapshot?: ArtifactDescriptor;
    /**
     * A whole-VM vmstate bundle manifest (Phase 2). Published HOST-side by
     * the plugin that owns the VMM — a guest cannot dump the VM it is
     * inside — and restored by machinenDriver().
     */
    vmstate?: ArtifactDescriptor;
  };
```

- [ ] **Step 4: Implement `resolveVmstate` in `src/artifacts.ts`**

Add to the import block at the top:

```ts
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
} from './vmstate.js';
```

Change the artifact-kind type (line 29) and `selectArtifact` (lines 217-223):

```ts
export type PullArtifactKind = 'image' | 'snapshot' | 'vmstate';
```

```ts
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
```

(If a test added in b867e5e pins the old two-kind error text, update its expectation to the new wording — search: `rg -n 'unknown \?artifact' test/`.)

Extend `ResolvePullOptions` (lines 45-48):

```ts
export interface ResolvePullOptions {
  /** Where artifacts are cached. Default: .machinen/cache */
  cacheDir?: string;
  /**
   * Override the installed @machinen/runtime version used for vmstate
   * compatibility negotiation. Default: read from the installed package.
   * (Exists for hermetic tests and unusual ops setups.)
   */
  machinenRuntimeVersion?: string;
}
```

Add `resolveVmstate` after `resolveSnapshot`:

```ts
async function resolveVmstate(
  spec: MachineSpec,
  manifest: MachineExposeManifest,
  cacheDir: string,
  startedAt: number,
  options: ResolvePullOptions,
): Promise<PullResolution> {
  const descriptor = requireDescriptor(spec, manifest, 'vmstate');
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
  const expectedHex = parseDigest(spec, pinned ?? descriptor.digest, 'vmstate artifact');

  const bundleUrl = joinArtifactUrl(spec.url!, descriptor.href);
  const res = await fetchOk(spec, bundleUrl, 'vmstate bundle manifest');
  const bundleText = await res.text();
  const actualHex = sha256Hex(bundleText);
  if (actualHex !== expectedHex) {
    fail(
      spec,
      `vmstate bundle manifest digest mismatch: expected "sha256:${expectedHex}" but ${bundleUrl} served bytes hashing to "sha256:${actualHex}"`,
    );
  }
  let bundle: VmstateBundleManifest;
  try {
    bundle = parseVmstateBundleManifest(bundleText, `at ${bundleUrl}`);
  } catch (error) {
    fail(spec, (error as Error).message);
  }

  // The requiredVersion analog for hardware/runtime: reject BEFORE any blob
  // bytes move, with a negotiation-style error instead of a VMM crash.
  const machinenRuntime = options.machinenRuntimeVersion ?? installedMachinenRuntimeVersion();
  if (!machinenRuntime) {
    fail(
      spec,
      'vmstate pull needs @machinen/runtime installed to negotiate bundle compatibility ' +
        '(it is an optional peer dependency: `pnpm add @machinen/runtime@0.4.0`)',
    );
  }
  const incompatible = vmstateCompatibilityError(bundle.compatibility, {
    platform: hostOci,
    machinenRuntime,
  });
  if (incompatible) fail(spec, incompatible);

  const blobDir = path.join(cacheDir, 'blobs', 'sha256');
  let bytesFetched = 0;
  const blobPaths: string[] = [];
  for (const file of bundle.files) {
    let blob: CachedBlob;
    try {
      blob = await ensureBlobCached(joinArtifactUrl(spec.url!, file.href), file, blobDir);
    } catch (error) {
      fail(spec, (error as Error).message);
    }
    bytesFetched += blob.fetched;
    blobPaths.push(blob.localPath);
  }

  const destDir = path.join(cacheDir, 'vmstate', `sha256-${expectedHex}`);
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
```

Extend the switch at the bottom of `resolvePullEntry`:

```ts
  const artifact = selectArtifact(spec);
  switch (artifact) {
    case 'image':
      return resolveImage(spec, manifest, cacheDir, startedAt);
    case 'snapshot':
      return resolveSnapshot(spec, manifest, cacheDir, startedAt);
    case 'vmstate':
      return resolveVmstate(spec, manifest, cacheDir, startedAt, options);
    default: {
      const unreachable: never = artifact;
      throw new Error(`[machinen-plugin] unknown artifact kind: ${String(unreachable)}`);
    }
  }
```

Also update the `requireDescriptor` error path: no change needed — `manifest.artifacts?.[artifact]` already covers the new key once `types.ts` carries it.

- [ ] **Step 5: Run the resolver tests, then the full suite**

Run: `pnpm vitest run test/vmstate-resolver.test.ts`
Expected: PASS (10 tests)
Run: `pnpm vitest run`
Expected: PASS — pre-existing `artifacts.test.ts`/`pull.test.ts` untouched by the changes (except a possibly updated `?artifact=` error-message expectation).

- [ ] **Step 6: Commit**

```bash
git add packages/runtime-plugin/src/types.ts packages/runtime-plugin/src/artifacts.ts packages/runtime-plugin/test/vmstate-resolver.test.ts
git commit -m "Resolve ?artifact=vmstate pulls: negotiate compatibility, stream blobs, materialize restore dirs"
```

---

### Task 5: Publisher — `publishSnapshotDir()` writes the content-addressed layout

**Files:**
- Create: `packages/runtime-plugin/src/publish.ts`
- Test: `packages/runtime-plugin/test/publish.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/runtime-plugin/test/publish.test.ts
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { publishSnapshotDir } from '../src/publish.js';
import type { MachineExposeManifest } from '../src/types.js';
import { VMSTATE_FORMAT, parseVmstateBundleManifest } from '../src/vmstate.js';

function hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const GUEST_MANIFEST: MachineExposeManifest = {
  name: 'vm_machine',
  protocol: 3,
  version: '1.2.0',
  artifacts: {
    image: { href: '/mf-image', format: 'guest-bundle', digest: `sha256:${'c'.repeat(64)}`, ext: '.js' },
  },
  exposes: { './counter': { increment: { params: [], returns: 'number' } } },
};

const FILES: Record<string, Buffer> = {
  'meta.json': Buffer.from('{"machinen":"meta"}'),
  'state.vmstate': Buffer.from('vm-ram-'.repeat(2000)),
  'federated-machine.json': Buffer.from(JSON.stringify({ remoteName: 'vm_machine', guestPort: 3801 })),
};

async function fakeSnapshotDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'publish-snap-'));
  for (const [name, bytes] of Object.entries(FILES)) {
    await writeFile(path.join(dir, name), bytes);
  }
  return dir;
}

describe('publishSnapshotDir', () => {
  test('writes blobs, bundle.json, and a vmstate-only mf-manifest.json into the layout', async () => {
    const snapDir = await fakeSnapshotDir();
    const layoutDir = await mkdtemp(path.join(os.tmpdir(), 'publish-layout-'));

    const published = await publishSnapshotDir({
      snapDir,
      name: 'vm_machine',
      manifest: GUEST_MANIFEST,
      layoutDir,
    });

    const machineDir = path.join(layoutDir, 'machines', 'vm_machine');
    expect(published.machineDir).toBe(machineDir);

    // every snapshot file landed as a digest-named blob
    for (const bytes of Object.values(FILES)) {
      expect(existsSync(path.join(machineDir, 'blobs', 'sha256', hex(bytes)))).toBe(true);
    }

    // bundle.json digest IS the published digest
    const bundleText = await readFile(published.bundlePath, 'utf8');
    expect(published.digest).toBe(`sha256:${hex(bundleText)}`);
    const bundle = parseVmstateBundleManifest(bundleText, 'at published bundle');
    expect(bundle.name).toBe('vm_machine');
    expect(bundle.files).toHaveLength(3);
    expect(published.bytes).toBe(Object.values(FILES).reduce((sum, b) => sum + b.length, 0));

    // the published manifest keeps guest identity but carries ONLY vmstate
    const manifest = JSON.parse(
      await readFile(path.join(machineDir, 'mf-manifest.json'), 'utf8'),
    ) as MachineExposeManifest;
    expect(manifest.name).toBe('vm_machine');
    expect(manifest.version).toBe('1.2.0');
    expect(manifest.exposes['./counter']).toBeDefined();
    expect(manifest.artifacts?.vmstate).toEqual(published.descriptor);
    expect(manifest.artifacts?.image).toBeUndefined();
    expect(manifest.artifacts?.snapshot).toBeUndefined();

    // descriptor points at the bundle within the machine base
    expect(published.descriptor.href).toBe(
      `vmstate/${published.digest.replace(':', '-')}/bundle.json`,
    );
    expect(published.descriptor.format).toBe(VMSTATE_FORMAT);
  });

  test('republishing writes a second bundle and the manifest advertises the latest', async () => {
    // createdAt is part of the bundle bytes, so each publish gets its own
    // digest and bundle dir; blobs dedupe by content underneath.
    const snapDir = await fakeSnapshotDir();
    const layoutDir = await mkdtemp(path.join(os.tmpdir(), 'publish-layout-'));

    const first = await publishSnapshotDir({
      snapDir,
      name: 'vm_machine',
      manifest: GUEST_MANIFEST,
      layoutDir,
    });
    const second = await publishSnapshotDir({
      snapDir,
      name: 'vm_machine',
      manifest: GUEST_MANIFEST,
      layoutDir,
    });
    expect(existsSync(first.bundlePath)).toBe(true);
    expect(existsSync(second.bundlePath)).toBe(true);
    // the served manifest advertises the LATEST publish
    const manifest = JSON.parse(
      await readFile(path.join(first.machineDir, 'mf-manifest.json'), 'utf8'),
    ) as MachineExposeManifest;
    expect(manifest.artifacts?.vmstate?.digest).toBe(second.digest);
  });

  test('compatibility overrides land in the bundle', async () => {
    const snapDir = await fakeSnapshotDir();
    const layoutDir = await mkdtemp(path.join(os.tmpdir(), 'publish-layout-'));

    const published = await publishSnapshotDir({
      snapDir,
      name: 'vm_machine',
      manifest: GUEST_MANIFEST,
      layoutDir,
      compatibility: { platform: 'linux/never-arch', machinenRuntime: '9.9.9' },
    });
    const bundle = parseVmstateBundleManifest(
      await readFile(published.bundlePath, 'utf8'),
      'at published bundle',
    );
    expect(bundle.compatibility.platform).toBe('linux/never-arch');
    expect(bundle.compatibility.machinenRuntime).toBe('9.9.9');
    expect(published.descriptor.platform).toBe('linux/never-arch');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/publish.test.ts`
Expected: FAIL — `Cannot find module '../src/publish.js'`

- [ ] **Step 3: Implement `src/publish.ts`**

```ts
// packages/runtime-plugin/src/publish.ts
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactDescriptor, MachineExposeManifest } from './types.js';
import {
  VMSTATE_FORMAT,
  VMSTATE_RESEED,
  VMSTATE_SNAPSHOT_ENGINE,
  buildVmstateBundle,
  installedMachinenRuntimeVersion,
  linkOrCopy,
  ociHostPlatform,
  type VmstateCompatibility,
} from './vmstate.js';

/**
 * Producer side of vmstate federation — PLUGIN-OWNED plumbing. The user
 * never deploys this: plugin.publishMachine() calls publishSnapshotDir()
 * and lazily starts the artifact endpoint (see startArtifactEndpoint below,
 * Task 6), the way machinenDriver() lazily loads @machinen/runtime.
 *
 * Layout (static files; copy it to any HTTP host and it serves identically):
 *
 *   <layoutDir>/machines/<name>/mf-manifest.json
 *   <layoutDir>/machines/<name>/vmstate/sha256-<hex>/bundle.json
 *   <layoutDir>/machines/<name>/blobs/sha256/<hex>
 */

export const DEFAULT_PUBLISH_DIR = path.join('.machinen', 'registry');

export interface PublishSnapshotDirOptions {
  /** The machinen snapshot bundle directory to publish. */
  snapDir: string;
  /** Machine name; becomes the layout key under machines/<name>. */
  name: string;
  /**
   * The machine's live manifest. exposes/version/metaData stay guest-owned;
   * the published copy carries ONLY the vmstate artifact (this layout does
   * not serve /mf-image or /mf-snapshot).
   */
  manifest: MachineExposeManifest;
  /** Layout root. Default: .machinen/registry */
  layoutDir?: string;
  /** Compatibility overrides; defaults describe this host + installed runtime. */
  compatibility?: Partial<VmstateCompatibility>;
}

export interface PublishedVmstate {
  /** sha256:<hex> of the published bundle.json bytes — the entry pin. */
  digest: string;
  /** Total artifact bytes across all bundle files. */
  bytes: number;
  /** Layout directory of this machine (its base-URL path when served). */
  machineDir: string;
  /** Path of the published bundle manifest. */
  bundlePath: string;
  descriptor: ArtifactDescriptor;
}

/** publishMachine() result: the layout facts plus the served base URL. */
export type PublishedMachine = PublishedVmstate & { url: string };

export async function publishSnapshotDir(
  options: PublishSnapshotDirOptions,
): Promise<PublishedVmstate> {
  const layoutDir = options.layoutDir ?? DEFAULT_PUBLISH_DIR;
  const machinenRuntime =
    options.compatibility?.machinenRuntime ?? installedMachinenRuntimeVersion();
  if (!machinenRuntime) {
    throw new Error(
      `[machinen-plugin] publish "${options.name}": cannot record bundle compatibility — ` +
        '@machinen/runtime is not installed and no compatibility.machinenRuntime override was given',
    );
  }
  const compatibility: VmstateCompatibility = {
    platform: options.compatibility?.platform ?? ociHostPlatform(),
    machinenRuntime,
    vmstateFormat: VMSTATE_FORMAT,
    snapshotEngine: options.compatibility?.snapshotEngine ?? VMSTATE_SNAPSHOT_ENGINE,
    reseed: options.compatibility?.reseed ?? VMSTATE_RESEED,
  };

  const built = await buildVmstateBundle(options.snapDir, {
    name: options.name,
    compatibility,
  });

  const machineDir = path.join(layoutDir, 'machines', options.name);
  const blobDir = path.join(machineDir, 'blobs', 'sha256');
  await mkdir(blobDir, { recursive: true });
  for (const [i, file] of built.manifest.files.entries()) {
    await linkOrCopy(built.sources[i], path.join(blobDir, file.digest.slice('sha256:'.length)));
  }

  const bundleJson = JSON.stringify(built.manifest, null, 2);
  const digestHex = createHash('sha256').update(bundleJson).digest('hex');
  const bundleDir = path.join(machineDir, 'vmstate', `sha256-${digestHex}`);
  await mkdir(bundleDir, { recursive: true });
  const bundlePath = path.join(bundleDir, 'bundle.json');
  await writeFile(bundlePath, bundleJson);

  const bytes = built.manifest.files.reduce((sum, file) => sum + file.bytes, 0);
  const descriptor: ArtifactDescriptor = {
    href: `vmstate/sha256-${digestHex}/bundle.json`,
    format: VMSTATE_FORMAT,
    digest: `sha256:${digestHex}`,
    bytes,
    platform: compatibility.platform,
  };

  // Guest identity (name/version/exposes/metaData) is preserved verbatim;
  // artifacts are replaced with only what this layout actually serves.
  const { artifacts: _guestArtifacts, ...guestManifest } = options.manifest;
  const published: MachineExposeManifest = {
    ...guestManifest,
    artifacts: { vmstate: descriptor },
  };
  await writeFile(
    path.join(machineDir, 'mf-manifest.json'),
    JSON.stringify(published, null, 2),
  );

  return { digest: `sha256:${digestHex}`, bytes, machineDir, bundlePath, descriptor };
}
```

Note: `linkOrCopy` may hit an existing blob on republish — `link()` fails `EEXIST`, the `copyFile` fallback overwrites with identical (content-addressed) bytes. Accepted for 2a.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/publish.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-plugin/src/publish.ts packages/runtime-plugin/test/publish.test.ts
git commit -m "Publish machinen snapshot dirs as content-addressed vmstate layouts with vmstate-only manifests"
```

---

### Task 6: The plugin-owned artifact endpoint — read-only loopback HTTP over the layout

**Files:**
- Modify: `packages/runtime-plugin/src/publish.ts` (append)
- Test: `packages/runtime-plugin/test/publish.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `packages/runtime-plugin/test/publish.test.ts` (merge `afterAll` import and add a closers array; merge `startArtifactEndpoint` into the publish import):

```ts
import { afterAll } from 'vitest';
import { startArtifactEndpoint, type ArtifactEndpoint } from '../src/publish.js';

const endpoints: ArtifactEndpoint[] = [];
afterAll(async () => {
  await Promise.all(endpoints.map((e) => e.close()));
});

describe('startArtifactEndpoint', () => {
  async function publishedLayout(extraMachine?: string) {
    const layoutDir = await mkdtemp(path.join(os.tmpdir(), 'endpoint-layout-'));
    const published = await publishSnapshotDir({
      snapDir: await fakeSnapshotDir(),
      name: 'vm_machine',
      manifest: GUEST_MANIFEST,
      layoutDir,
    });
    if (extraMachine) {
      await publishSnapshotDir({
        snapDir: await fakeSnapshotDir(),
        name: extraMachine,
        manifest: { ...GUEST_MANIFEST, name: extraMachine },
        layoutDir,
      });
    }
    const endpoint = await startArtifactEndpoint({ layoutDir });
    endpoints.push(endpoint);
    return { endpoint, published };
  }

  test('serves manifest, bundle, and blobs under /machines/<name>', async () => {
    const { endpoint, published } = await publishedLayout();
    const base = `${endpoint.url}/machines/vm_machine`;

    const manifest = (await (await fetch(`${base}/mf-manifest.json`)).json()) as MachineExposeManifest;
    expect(manifest.artifacts?.vmstate?.digest).toBe(published.digest);

    const bundleRes = await fetch(`${base}/${published.descriptor.href}`);
    expect(bundleRes.status).toBe(200);
    expect(`sha256:${hex(Buffer.from(await bundleRes.arrayBuffer()))}`).toBe(published.digest);

    const blobHex = hex(FILES['state.vmstate']);
    const blobRes = await fetch(`${base}/blobs/sha256/${blobHex}`);
    expect(blobRes.status).toBe(200);
    expect(blobRes.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await blobRes.arrayBuffer())).toEqual(FILES['state.vmstate']);
  });

  test('honors single byte ranges on blobs', async () => {
    const { endpoint } = await publishedLayout();
    const blobHex = hex(FILES['state.vmstate']);
    const res = await fetch(
      `${endpoint.url}/machines/vm_machine/blobs/sha256/${blobHex}`,
      { headers: { range: 'bytes=0-6' } },
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(
      `bytes 0-6/${FILES['state.vmstate'].length}`,
    );
    expect(Buffer.from(await res.arrayBuffer())).toEqual(FILES['state.vmstate'].subarray(0, 7));
  });

  test('root-mounts the single published machine; stops when a second appears', async () => {
    const single = await publishedLayout();
    const rootManifest = await fetch(`${single.endpoint.url}/mf-manifest.json`);
    expect(rootManifest.status).toBe(200);

    const double = await publishedLayout('other_machine');
    expect((await fetch(`${double.endpoint.url}/mf-manifest.json`)).status).toBe(404);
    expect(
      (await fetch(`${double.endpoint.url}/machines/other_machine/mf-manifest.json`)).status,
    ).toBe(200);
  });

  test('is read-only and traversal-safe', async () => {
    const { endpoint } = await publishedLayout();
    expect(
      (await fetch(`${endpoint.url}/machines/vm_machine/mf-manifest.json`, { method: 'POST' }))
        .status,
    ).toBe(405);
    expect((await fetch(`${endpoint.url}/machines/../package.json`)).status).toBe(404);
    expect((await fetch(`${endpoint.url}/machines/vm_machine/blobs/sha256/nope`)).status).toBe(404);
  });

  test('binds loopback by default', async () => {
    const { endpoint } = await publishedLayout();
    expect(endpoint.url.startsWith('http://127.0.0.1:')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify the new block fails**

Run: `pnpm vitest run test/publish.test.ts`
Expected: new tests FAIL (`startArtifactEndpoint` not exported); Task 5 tests PASS.

- [ ] **Step 3: Implement in `src/publish.ts`**

Extend the import block:

```ts
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
```

Append:

```ts
export interface ArtifactEndpointOptions {
  layoutDir: string;
  /** Loopback by default — serving VM memory off-host is a deliberate act. */
  hostname?: string;
  /** 0 (default) picks a free port. */
  port?: number;
}

export interface ArtifactEndpoint {
  url: string;
  port: number;
  close(): Promise<void>;
}

// Same segment discipline as bundle paths: no dots-only names, no separators.
const PATH_SEGMENT_RE = /^(?!\.+$)[A-Za-z0-9._-]+$/;

function safeJoin(root: string, segments: string[]): string | undefined {
  if (!segments.length || !segments.every((segment) => PATH_SEGMENT_RE.test(segment))) {
    return undefined;
  }
  return path.join(root, ...segments);
}

/** Single-range "bytes=a-b" parsing; anything else serves the full file. */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | undefined {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header) : null;
  if (!match || (!match[1] && !match[2])) return undefined;
  const start = match[1] ? Number(match[1]) : size - Number(match[2]);
  const end = match[1] && match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return undefined;
  if (start < 0 || end >= size || start > end) return undefined;
  return { start, end };
}

/**
 * The plugin-owned artifact endpoint: a read-only static server over the
 * publish layout. GET only; loopback by default; Range honored. The same
 * layout copied to any static host serves identically — this server is
 * plumbing the plugin owns, not a product the user operates.
 */
export async function startArtifactEndpoint(
  options: ArtifactEndpointOptions,
): Promise<ArtifactEndpoint> {
  const hostname = options.hostname ?? '127.0.0.1';
  const machinesRoot = path.join(options.layoutDir, 'machines');

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' });
        res.end();
        return;
      }
      const segments = (req.url ?? '').split('?')[0].split('/').filter(Boolean);
      let machineSegments: string[];
      if (segments[0] === 'machines') {
        machineSegments = segments.slice(1);
      } else {
        // Root mount: with exactly one published machine, the bare base URL
        // serves it — the single-machine Phase 1 URL shape.
        const names = await readdir(machinesRoot).catch(() => [] as string[]);
        if (names.length !== 1) {
          res.writeHead(404);
          res.end();
          return;
        }
        machineSegments = [names[0], ...segments];
      }
      const file = safeJoin(machinesRoot, machineSegments);
      const info = file ? await stat(file).catch(() => undefined) : undefined;
      if (!file || !info?.isFile()) {
        res.writeHead(404);
        res.end();
        return;
      }
      const type = file.endsWith('.json') ? 'application/json' : 'application/octet-stream';
      const range = parseRange(req.headers.range, info.size);
      if (range) {
        res.writeHead(206, {
          'content-type': type,
          'content-length': range.end - range.start + 1,
          'content-range': `bytes ${range.start}-${range.end}/${info.size}`,
          'accept-ranges': 'bytes',
        });
        createReadStream(file, { start: range.start, end: range.end }).pipe(res);
      } else {
        res.writeHead(200, {
          'content-type': type,
          'content-length': info.size,
          'accept-ranges': 'bytes',
        });
        createReadStream(file).pipe(res);
      }
    } catch {
      res.writeHead(500);
      res.end();
    }
  });

  server.listen(options.port ?? 0, hostname);
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 0);
  return {
    url: `http://${hostname}:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/publish.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-plugin/src/publish.ts packages/runtime-plugin/test/publish.test.ts
git commit -m "Serve the publish layout from a read-only loopback artifact endpoint with Range support"
```

---

### Task 7: `plugin.publishMachine()` — lifecycle verb, hooks, lazy endpoint, dispose

**Files:**
- Modify: `packages/runtime-plugin/src/hooks.ts` (two new hooks)
- Modify: `packages/runtime-plugin/src/plugin.ts` (options ~line 27-37, plugin type ~line 39-51, verb + lazy endpoint, `disposeMachines` ~line 433-447)
- Modify: `packages/runtime-plugin/src/client.ts` (`MachinesOptions` ~line 21-45, passthrough ~line 109-115)
- Modify: `packages/runtime-plugin/src/index.ts` (exports)
- Test: `packages/runtime-plugin/test/plugin-publish.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/runtime-plugin/test/plugin-publish.test.ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createMachines, type MachinesClient } from '../src/client.js';
import type { MachineDriver, MachineExposeManifest, MachineHandle } from '../src/types.js';

const MANIFEST: MachineExposeManifest = {
  name: 'pub_machine',
  protocol: 3,
  version: '1.0.0',
  exposes: { './counter': { current: { params: [], returns: 'number' } } },
};

async function fakeSnapshotDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'plugin-pub-snap-'));
  await writeFile(path.join(dir, 'meta.json'), '{"machinen":"meta"}');
  await writeFile(path.join(dir, 'state.vmstate'), 'fake-vm-state-'.repeat(100));
  await writeFile(
    path.join(dir, 'federated-machine.json'),
    JSON.stringify({ remoteName: 'pub_machine', guestPort: 3801 }),
  );
  return dir;
}

/** A driver whose handle snapshots into a prepared machinen-shaped dir. */
function stubVmDriver(snapDir: string, snapshots: unknown[] = []): MachineDriver {
  const handle: MachineHandle = {
    manifest: async () => MANIFEST,
    call: async () => 7,
    snapshot: async () => {
      const result = { snapDir, image: 'base.tar.gz' };
      snapshots.push(result);
      return result;
    },
  };
  return { boot: async () => handle };
}

const clients: MachinesClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.plugin.disposeMachines();
  }
});

describe('plugin.publishMachine', () => {
  async function bootedPublisher() {
    const layoutDir = await mkdtemp(path.join(os.tmpdir(), 'plugin-pub-layout-'));
    const machines = createMachines({
      driver: stubVmDriver(await fakeSnapshotDir()),
      publish: { dir: layoutDir },
      remotes: { pub_machine: 'machinen://ignored-by-stub.js' },
    });
    clients.push(machines);
    await expect(machines.machine('pub_machine').counter.current()).resolves.toBe(7);
    return machines;
  }

  test('snapshots, publishes, lazily starts the endpoint, and serves the merged manifest', async () => {
    const machines = await bootedPublisher();
    const events: string[] = [];
    machines.plugin.machineHooks.beforePublish.on(() => void events.push('beforePublish'));
    machines.plugin.machineHooks.beforeSnapshot.on(() => void events.push('beforeSnapshot'));
    machines.plugin.machineHooks.onSnapshotted.on(() => void events.push('onSnapshotted'));
    machines.plugin.machineHooks.onPublished.on(({ published }) => {
      events.push('onPublished');
      expect(published.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/machines\/pub_machine$/);
    });

    const published = await machines.plugin.publishMachine('pub_machine');

    expect(events).toEqual(['beforePublish', 'beforeSnapshot', 'onSnapshotted', 'onPublished']);
    expect(published.digest).toMatch(/^sha256:[a-f0-9]{64}$/);

    // The endpoint is live and serves the guest manifest + vmstate artifact.
    const manifest = (await (
      await fetch(`${published.url}/mf-manifest.json`)
    ).json()) as MachineExposeManifest;
    expect(manifest.name).toBe('pub_machine');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.artifacts?.vmstate?.digest).toBe(published.digest);

    // Root mount also works while it is the only published machine.
    expect((await fetch(`${published.url.replace('/machines/pub_machine', '')}/mf-manifest.json`)).status).toBe(200);
  });

  test('disposeMachines closes the endpoint', async () => {
    const machines = await bootedPublisher();
    const published = await machines.plugin.publishMachine('pub_machine');
    await machines.plugin.disposeMachines();

    await expect(fetch(`${published.url}/mf-manifest.json`)).rejects.toThrow();
  });

  test('publishMachine without publish options fails with configuration guidance', async () => {
    const machines = createMachines({
      driver: stubVmDriver(await fakeSnapshotDir()),
      remotes: { pub_machine: 'machinen://ignored-by-stub.js' },
    });
    clients.push(machines);
    await machines.machine('pub_machine').counter.current();

    await expect(machines.plugin.publishMachine('pub_machine')).rejects.toThrow(
      /publish options.*createMachines\(\{ publish/s,
    );
  });

  test('a non-vmstate snapshot (no machinen bundle dir) is refused with the driver hint', async () => {
    const notASnapDir = await mkdtemp(path.join(os.tmpdir(), 'plugin-pub-not-snap-'));
    const machines = createMachines({
      driver: stubVmDriver(notASnapDir), // dir exists but has no meta.json/state.vmstate
      publish: { dir: await mkdtemp(path.join(os.tmpdir(), 'plugin-pub-layout-')) },
      remotes: { pub_machine: 'machinen://ignored-by-stub.js' },
    });
    clients.push(machines);
    await machines.machine('pub_machine').counter.current();

    await expect(machines.plugin.publishMachine('pub_machine')).rejects.toThrow(
      /machinenDriver/,
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/plugin-publish.test.ts`
Expected: FAIL — `publish` is not a known `createMachines` option / `publishMachine` is not a function.

- [ ] **Step 3: Add the hooks in `src/hooks.ts`**

Add the import at the top:

```ts
import type { PublishedMachine } from './publish.js';
```

Add to `MachineHooks` (after `onForked`):

```ts
  /** publishMachine() is about to snapshot + publish this machine. */
  beforePublish: AsyncSeriesHook<{ spec: MachineSpec }>;
  /** The bundle landed in the layout and the artifact endpoint serves it. */
  onPublished: AsyncSeriesHook<{ spec: MachineSpec; published: PublishedMachine }>;
```

Add to `createMachineHooks()` (after `onForked`):

```ts
    beforePublish: new AsyncSeriesHook(),
    onPublished: new AsyncSeriesHook(),
```

- [ ] **Step 4: Wire the verb and lazy endpoint in `src/plugin.ts`**

Add imports at the top:

```ts
import { isMachinenSnapshotDir } from './drivers/machinen.js';
import {
  DEFAULT_PUBLISH_DIR,
  publishSnapshotDir,
  startArtifactEndpoint,
  type ArtifactEndpoint,
  type PublishedMachine,
} from './publish.js';
```

(`drivers/machinen.js` is import-safe without `@machinen/runtime`: the runtime loads lazily inside `loadRuntime()` only.)

Add to `MachinenPluginOptions`:

```ts
  /**
   * Enables plugin-owned vmstate publication: publishMachine() writes
   * content-addressed bundles under `dir` and a lazily started loopback
   * endpoint serves them. Plumbing the plugin owns — nothing to deploy.
   */
  publish?: { dir?: string; hostname?: string; port?: number };
```

Add to the `MachinenPlugin` type (after `forkMachine`):

```ts
  /**
   * Snapshot a booted machine's whole VM and publish it as a
   * machinen-vmstate@1 bundle served by the plugin's artifact endpoint.
   * Requires `publish` options and a whole-VM-snapshotting driver
   * (machinenDriver()).
   */
  publishMachine(remoteName: string): Promise<PublishedMachine>;
```

Inside `machinenPlugin()` (next to the other module-level state, after `resolutions`):

```ts
  /** Lazily started artifact endpoint; closed by disposeMachines(). */
  let endpoint: Promise<ArtifactEndpoint> | undefined;

  function ensureEndpoint(publish: NonNullable<MachinenPluginOptions['publish']>): Promise<ArtifactEndpoint> {
    endpoint ??= startArtifactEndpoint({
      layoutDir: publish.dir ?? DEFAULT_PUBLISH_DIR,
      hostname: publish.hostname,
      port: publish.port,
    });
    return endpoint;
  }
```

Add the verb to the returned plugin object (after `forkMachine`):

```ts
    async publishMachine(remoteName) {
      const publish = options.publish;
      if (!publish) {
        throw new Error(
          `[machinen-plugin] publishMachine("${remoteName}") needs publish options — ` +
            'pass createMachines({ publish: { dir: ".machinen/registry" } })',
        );
      }
      const machine = await findMachine(remoteName);
      if (!machine.handle.snapshot) {
        throw new Error(`[machinen-plugin] driver for "${remoteName}" does not support snapshot`);
      }
      await machineHooks.beforePublish.emit({ spec: machine.spec });
      await machineHooks.beforeSnapshot.emit({ spec: machine.spec });
      const snapshot = await machine.handle.snapshot();
      await machineHooks.onSnapshotted.emit({ spec: machine.spec, snapshot });

      const snapDir = (snapshot as { snapDir?: unknown } | undefined)?.snapDir;
      if (typeof snapDir !== 'string' || !(await isMachinenSnapshotDir(snapDir))) {
        throw new Error(
          `[machinen-plugin] publishMachine("${remoteName}"): the driver's snapshot is not a ` +
            'machinen vmstate bundle directory — whole-VM publication needs machinenDriver() ' +
            '(app-state snapshots travel through ?artifact=snapshot instead)',
        );
      }
      const result = await publishSnapshotDir({
        snapDir,
        name: remoteName,
        manifest: machine.manifest,
        layoutDir: publish.dir ?? DEFAULT_PUBLISH_DIR,
      });
      const live = await ensureEndpoint(publish);
      const published: PublishedMachine = {
        ...result,
        url: `${live.url}/machines/${remoteName}`,
      };
      await machineHooks.onPublished.emit({ spec: machine.spec, published });
      return published;
    },
```

Extend `disposeMachines()` — add before the existing `const booted = ...` line:

```ts
      const closingEndpoint = endpoint;
      endpoint = undefined;
      if (closingEndpoint) {
        await closingEndpoint.then((live) => live.close()).catch(() => {});
      }
```

- [ ] **Step 5: Pass through in `src/client.ts` and export in `src/index.ts`**

Add to `MachinesOptions`:

```ts
  /**
   * Enables plugin-owned vmstate publication (plugin.publishMachine() +
   * a lazily started loopback artifact endpoint over `dir`).
   * Default dir: .machinen/registry
   */
  publish?: { dir?: string; hostname?: string; port?: number };
```

Add to the `machinenPlugin({ ... })` call inside `createMachines`:

```ts
    publish: options.publish,
```

Add to `src/index.ts`:

```ts
export {
  DEFAULT_PUBLISH_DIR,
  publishSnapshotDir,
  startArtifactEndpoint,
  type ArtifactEndpoint,
  type ArtifactEndpointOptions,
  type PublishSnapshotDirOptions,
  type PublishedMachine,
  type PublishedVmstate,
} from './publish.js';
export {
  VMSTATE_FORMAT,
  buildVmstateBundle,
  ensureBlobCached,
  installedMachinenRuntimeVersion,
  materializeVmstateDir,
  ociHostPlatform,
  parseVmstateBundleManifest,
  sha256File,
  vmstateCompatibilityError,
  type BuiltVmstateBundle,
  type VmstateBundleManifest,
  type VmstateCompatibility,
  type VmstateFileEntry,
  type VmstateHost,
} from './vmstate.js';
```

- [ ] **Step 6: Run the new tests, then the full suite**

Run: `pnpm vitest run test/plugin-publish.test.ts`
Expected: PASS (4 tests)
Run: `pnpm vitest run`
Expected: PASS (no regressions; `plugin.test.ts` and `pull.test.ts` unaffected).

- [ ] **Step 7: Commit**

```bash
git add packages/runtime-plugin/src/hooks.ts packages/runtime-plugin/src/plugin.ts packages/runtime-plugin/src/client.ts packages/runtime-plugin/src/index.ts packages/runtime-plugin/test/plugin-publish.test.ts
git commit -m "Add plugin.publishMachine(): publish hooks, lazy artifact endpoint, dispose-time shutdown"
```

---

### Task 8: Producer ↔ consumer integration over real HTTP (no KVM)

**Files:**
- Test: `packages/runtime-plugin/test/vmstate-pull.test.ts`

The full loop with fakes standing in for the VM only: a producer plugin (stub
snapshot driver) publishes through `publishMachine()`, a consumer resolves the
`machinen+pull+...?artifact=vmstate` entry against the live endpoint, and a
recording fake driver proves the plugin hands drivers a materialized
snapshot-dir boot. No production code should change in this task — it pins the
seams between Tasks 4-7.

- [ ] **Step 1: Write the tests**

```ts
// packages/runtime-plugin/test/vmstate-pull.test.ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { resolvePullEntry } from '../src/artifacts.js';
import { createMachines, type MachinesClient } from '../src/client.js';
import { isMachinenSnapshotDir } from '../src/drivers/machinen.js';
import {
  parseMachineEntry,
  type MachineDriver,
  type MachineExposeManifest,
  type MachineHandle,
  type MachineSpec,
} from '../src/types.js';

const MANIFEST: MachineExposeManifest = {
  name: 'vm_machine',
  protocol: 3,
  version: '2.0.0',
  exposes: { './counter': { increment: { params: [], returns: 'number' } } },
};

const FILES: Record<string, string> = {
  'meta.json': '{"machinen":"meta"}',
  'state.vmstate': `vm-heap-${'x'.repeat(64 * 1024)}`,
  'federated-machine.json': JSON.stringify({ remoteName: 'vm_machine', guestPort: 3801 }),
};

async function fakeSnapshotDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'e2e-snap-'));
  for (const [name, contents] of Object.entries(FILES)) {
    await writeFile(path.join(dir, name), contents);
  }
  return dir;
}

function producerDriver(snapDir: string): MachineDriver {
  const handle: MachineHandle = {
    manifest: async () => MANIFEST,
    call: async () => 2,
    snapshot: async () => ({ snapDir, image: 'base.tar.gz' }),
  };
  return { boot: async () => handle };
}

/** Records the spec it boots; "restores" by answering from the dir's presence. */
function recordingConsumerDriver(booted: MachineSpec[]): MachineDriver {
  return {
    boot: async (spec) => {
      booted.push(spec);
      if (spec.kind !== 'image' || !spec.image || !(await isMachinenSnapshotDir(spec.image))) {
        throw new Error(`recording driver expected a materialized snapshot dir, got "${spec.entry}"`);
      }
      return { manifest: async () => MANIFEST, call: async () => 3 };
    },
  };
}

describe('vmstate fork-by-pull, fakes for the VM only', () => {
  const clients: MachinesClient[] = [];
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(os.tmpdir(), 'e2e-cache-'));
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) {
      await client.plugin.disposeMachines();
    }
  });

  async function publishedProducer() {
    const snapDir = await fakeSnapshotDir();
    const producer = createMachines({
      driver: producerDriver(snapDir),
      publish: { dir: await mkdtemp(path.join(os.tmpdir(), 'e2e-layout-')) },
      remotes: { vm_machine: 'machinen://ignored-by-stub.js' },
    });
    clients.push(producer);
    await producer.machine('vm_machine').counter.increment(); // boot
    const published = await producer.plugin.publishMachine('vm_machine');
    return { producer, published, snapDir };
  }

  test('resolvePullEntry against the live endpoint materializes byte-identical state', async () => {
    const { published, snapDir } = await publishedProducer();

    const spec = parseMachineEntry(
      'vm_machine',
      `machinen+pull+${published.url}?artifact=vmstate&version=^2.0.0`,
    );
    const resolution = await resolvePullEntry(spec, { cacheDir });

    expect(resolution.artifact).toBe('vmstate');
    expect(await isMachinenSnapshotDir(resolution.localPath)).toBe(true);
    for (const name of Object.keys(FILES)) {
      expect(await readFile(path.join(resolution.localPath, name))).toEqual(
        await readFile(path.join(snapDir, name)),
      );
    }
  });

  test('a full consumer client pulls, and its driver receives the materialized dir', async () => {
    const { published } = await publishedProducer();
    const booted: MachineSpec[] = [];

    const consumer = createMachines({
      driver: recordingConsumerDriver(booted),
      artifactCacheDir: cacheDir,
      remotes: { vm_machine: `machinen+pull+${published.url}?artifact=vmstate` },
    });
    clients.push(consumer);

    await expect(consumer.machine('vm_machine').counter.increment()).resolves.toBe(3);
    expect(booted).toHaveLength(1);
    expect(booted[0].kind).toBe('image');
    expect(booted[0].pulledFrom).toContain('machinen+pull+');
  });

  test('the root-mounted single-machine URL shape works too', async () => {
    const { published } = await publishedProducer();
    const rootUrl = published.url.replace('/machines/vm_machine', '');
    const booted: MachineSpec[] = [];

    const consumer = createMachines({
      driver: recordingConsumerDriver(booted),
      artifactCacheDir: cacheDir,
      remotes: { vm_machine: `machinen+pull+${rootUrl}?artifact=vmstate` },
    });
    clients.push(consumer);

    await expect(consumer.machine('vm_machine').counter.increment()).resolves.toBe(3);
  });

  test('two consumers pull the same digest; the second is served from its own cache dir', async () => {
    const { published } = await publishedProducer();

    const spec = (suffix: string) =>
      parseMachineEntry('vm_machine', `machinen+pull+${published.url}?artifact=vmstate${suffix}`);

    const first = await resolvePullEntry(spec(''), { cacheDir });
    const pinnedEntry = `&digest=${published.digest}`;
    const second = await resolvePullEntry(spec(pinnedEntry), { cacheDir });

    expect(first.localPath).toBe(second.localPath);
    expect(second.fromCache).toBe(true);
    expect(second.bytesFetched).toBe(0);
  });
});
```

Note: both sides default to the installed `@machinen/runtime` (`0.4.0` devDependency) for compatibility, so producer-recorded and consumer-checked versions agree hermetically.

- [ ] **Step 2: Run the tests**

Run: `pnpm vitest run test/vmstate-pull.test.ts`
Expected: PASS (4 tests). If a seam mismatch surfaces (URL shapes, digest naming), fix the PRODUCT code from Tasks 4-7 — this test file is the contract.

- [ ] **Step 3: Run the full suite**

Run: `pnpm vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/runtime-plugin/test/vmstate-pull.test.ts
git commit -m "Pin the vmstate publish-pull-restore loop end to end over real HTTP with fake VMs"
```

---

### Task 9: Real-VM fork-by-pull (KVM; skips honestly without it)

**Files:**
- Test: `packages/runtime-plugin/test/vmstate-machinen.test.ts`

Follows the `test/machinen-driver.test.ts` pattern exactly: probe for
`/dev/kvm` + `@machinen/runtime` + base assets, `describe.skipIf` with the
printed reason, generous timeout, dispose-and-verify cleanup. This is the
enforced proof of the Phase 2a claim: a real VM's published vmstate restores
on a pull entry and the clones diverge. Run it on any Linux box with usable
KVM (`pnpm vitest run test/vmstate-machinen.test.ts`); wiring it into
`.github/workflows/machinen.yml` is deferred.

- [ ] **Step 1: Write the test**

```ts
// packages/runtime-plugin/test/vmstate-machinen.test.ts
// REAL machinen fork-by-pull: boots an actual microVM, publishes its whole
// VM through plugin.publishMachine(), pulls it back through a
// machinen+pull+...?artifact=vmstate entry, and proves the restored clone
// continues mid-heap and diverges. Skips with the reason when machinen
// cannot run here (same honesty contract as machinen-driver.test.ts).
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { createMachines, type MachinesClient } from '../src/client.js';
import { machinenDriver } from '../src/drivers/machinen.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const MACHINEN_BIN = path.join(
  PACKAGE_ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'machinen.cmd' : 'machinen',
);
const GUEST_BUNDLE = path.join(REPO_ROOT, 'apps/remote/dist/index.js');
// Producer cold boot + snapshot + two restores + local 2.5GB transfers.
const FULL_CYCLE_TIMEOUT_MS = 600_000;
const BOOT_TIMEOUT_MS = 300_000;

async function machinenUnavailableReason(): Promise<string | null> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    return `unsupported platform ${process.platform}`;
  }
  if (process.platform === 'linux') {
    if (!existsSync('/dev/kvm')) return 'no /dev/kvm on this host';
    try {
      accessSync('/dev/kvm', constants.R_OK | constants.W_OK);
    } catch {
      return '/dev/kvm exists but is not read/writable by this user';
    }
  }
  try {
    const runtime = await import('@machinen/runtime');
    try {
      runtime.resolveBaseRootfs();
    } catch {
      if (!existsSync(MACHINEN_BIN)) {
        return `repo-local machinen CLI missing at ${MACHINEN_BIN}; run pnpm install`;
      }
      const install = spawnSync(MACHINEN_BIN, ['install'], {
        cwd: PACKAGE_ROOT,
        stdio: 'inherit',
        timeout: 240_000,
      });
      if (install.status !== 0) return 'machinen install (base asset fetch) failed';
      runtime.resolveBaseRootfs();
    }
  } catch (error) {
    return `@machinen/runtime not loadable: ${(error as Error).message}`;
  }
  return null;
}

const unavailable = await machinenUnavailableReason();
if (unavailable) {
  console.warn(`[vmstate-machinen.test] skipping real-VM suite: ${unavailable}`);
}

function ensureGuestBundle(): void {
  if (existsSync(GUEST_BUNDLE)) return;
  const result = spawnSync('pnpm', ['--filter', 'remote', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('pnpm --filter remote build failed');
}

describe.skipIf(unavailable !== null)('vmstate fork-by-pull (real microVMs)', () => {
  const clients: MachinesClient[] = [];
  let work: string | undefined;

  afterAll(async () => {
    for (const client of clients) {
      await client.plugin.disposeMachines().catch(() => {});
    }
    const runtime = await import('@machinen/runtime');
    const leftovers = runtime.list().filter((entry) => entry.name?.startsWith('fc-vm_machine'));
    expect(leftovers).toEqual([]);
    if (work) await rm(work, { recursive: true, force: true });
  }, 120_000);

  test(
    'snapshot -> publish -> pull -> restore: clone continues mid-heap and diverges',
    async () => {
      ensureGuestBundle();
      work = await mkdtemp(path.join(os.tmpdir(), 'vmstate-e2e-'));

      // Producer: a real VM, counter worked to 2.
      const producer = createMachines({
        driver: machinenDriver({ snapshotDir: path.join(work, 'snaps') }),
        publish: { dir: path.join(work, 'registry'), port: 0 },
        bootTimeoutMs: BOOT_TIMEOUT_MS,
        remotes: { vm_machine: `machinen://${GUEST_BUNDLE}?memory=1024` },
      });
      clients.push(producer);
      const producerCounter = producer.machine('vm_machine').counter;
      await producerCounter.increment();
      await expect(producerCounter.increment()).resolves.toBe(2);

      const published = await producer.plugin.publishMachine('vm_machine');
      expect(published.digest).toMatch(/^sha256:[a-f0-9]{64}$/);

      // Consumer A: pull entry restores the whole VM; heap continues 2 -> 3.
      const consumerA = createMachines({
        driver: machinenDriver(),
        artifactCacheDir: path.join(work, 'cache-a'),
        bootTimeoutMs: BOOT_TIMEOUT_MS,
        remotes: { vm_machine: `machinen+pull+${published.url}?artifact=vmstate` },
      });
      clients.push(consumerA);
      await expect(consumerA.machine('vm_machine').counter.increment()).resolves.toBe(3);

      // Consumer B: same bundle, independent clone — also resumes at 2 -> 3.
      const consumerB = createMachines({
        driver: machinenDriver(),
        artifactCacheDir: path.join(work, 'cache-b'),
        bootTimeoutMs: BOOT_TIMEOUT_MS,
        remotes: { vm_machine: `machinen+pull+${published.url}?artifact=vmstate` },
      });
      clients.push(consumerB);
      await expect(consumerB.machine('vm_machine').counter.increment()).resolves.toBe(3);

      // Divergence: three histories from one snapshot point.
      await expect(consumerA.machine('vm_machine').counter.increment()).resolves.toBe(4);
      await expect(producerCounter.increment()).resolves.toBe(3);
    },
    FULL_CYCLE_TIMEOUT_MS,
  );
});
```

- [ ] **Step 2: Verify the honest skip on a non-KVM machine**

Run: `pnpm vitest run test/vmstate-machinen.test.ts`
Expected (no KVM): suite skipped, reason printed (`skipping real-VM suite: ...`), exit 0.

- [ ] **Step 3: Run for real on a KVM-capable Linux host (when available)**

Run: `pnpm --filter @federated-compute/machinen-plugin build && pnpm --filter remote build && pnpm vitest run test/vmstate-machinen.test.ts` (in `packages/runtime-plugin`; first command from repo root)
Expected: PASS in well under 10 minutes; the log shows the producer boot, snapshot timing, and two restore-to-healthy lines from the driver.

- [ ] **Step 4: Commit**

```bash
git add packages/runtime-plugin/test/vmstate-machinen.test.ts
git commit -m "Prove real-VM fork-by-pull: publish a microVM's vmstate, pull it, restore, and diverge"
```

---

### Task 10: Final verification

- [ ] **Step 1: Full package suite + build**

Run (in `packages/runtime-plugin`): `pnpm vitest run && pnpm build`
Expected: all tests pass (new vmstate/publish/plugin-publish/vmstate-pull suites + every pre-existing suite; the two real-VM suites skip honestly without KVM); `tsc` build clean — this also type-checks the new public exports in `dist/index.d.ts`.

- [ ] **Step 2: Workspace build + existing demos still pass**

Run (repo root): `pnpm -r build && node scripts/demo-pull.mjs`
Expected: builds clean; the Phase 1 pull demo is unaffected (its `?artifact=snapshot`/`?artifact=image` paths share `resolvePullEntry` with the new code).

- [ ] **Step 3: Confirm scope honesty**

Re-read the plan header's deferred list and confirm none of it crept in: `rg -n "Range:" packages/runtime-plugin/src/artifacts.ts packages/runtime-plugin/src/vmstate.ts` finds nothing (no client-side range/resume), and no GC, compression, or workflow YAML changes exist in `git log --stat` for this branch segment.
