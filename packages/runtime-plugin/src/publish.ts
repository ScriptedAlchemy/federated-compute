import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
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
