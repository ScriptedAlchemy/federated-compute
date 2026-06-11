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
