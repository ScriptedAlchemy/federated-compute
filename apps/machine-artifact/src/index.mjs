import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_PUBLISH_DIR,
  assertValidPublishedMachineName,
  startArtifactEndpoint,
} from '@federated-compute/machinen-plugin';
import { createGuestRuntime, serveGuest } from '@federated-compute/machinen-plugin/guest';

const ARTIFACT_KINDS = new Set(['image', 'snapshot', 'vmstate']);
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;

const registryDir = path.resolve(
  process.env.MACHINEN_ARTIFACT_REGISTRY_DIR ?? DEFAULT_PUBLISH_DIR,
);
const machinesDir = path.join(registryDir, 'machines');

let artifactBaseUrl = '';

function machineManifestPath(name) {
  assertValidPublishedMachineName(name);
  return path.join(machinesDir, name, 'mf-manifest.json');
}

function artifactKind(value = 'vmstate') {
  if (!ARTIFACT_KINDS.has(value)) {
    throw new Error(`unknown artifact "${value}" (expected image, snapshot, or vmstate)`);
  }
  return value;
}

function machineBaseUrl(name) {
  return `${artifactBaseUrl}/machines/${encodeURIComponent(name)}`;
}

async function readManifest(name) {
  const file = machineManifestPath(name);
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile()) return null;
  if (info.size > MAX_MANIFEST_BYTES) {
    throw new Error(`manifest for "${name}" exceeds ${MAX_MANIFEST_BYTES} bytes`);
  }
  return JSON.parse(await readFile(file, 'utf8'));
}

async function listMachines() {
  const entries = await readdir(machinesDir, { withFileTypes: true }).catch(() => []);
  const machines = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = await readManifest(entry.name).catch(() => null);
    if (!manifest) continue;
    machines.push({
      name: manifest.name ?? entry.name,
      version: manifest.version ?? '0.0.0',
      artifacts: Object.keys(manifest.artifacts ?? {}),
      manifestUrl: `${machineBaseUrl(entry.name)}/mf-manifest.json`,
    });
  }
  machines.sort((a, b) => a.name.localeCompare(b.name));
  return machines;
}

async function getManifest(name) {
  return readManifest(name);
}

async function getArtifactDescriptor(name, artifact = 'vmstate') {
  const manifest = await readManifest(name);
  return manifest?.artifacts?.[artifactKind(artifact)] ?? null;
}

async function resolvePullEntry(name, artifact = 'vmstate') {
  const manifest = await readManifest(name);
  if (!manifest) throw new Error(`unknown machine "${name}"`);
  const kind = artifactKind(artifact);
  const descriptor = manifest.artifacts?.[kind];
  if (!descriptor) throw new Error(`machine "${name}" does not publish artifact "${kind}"`);

  const params = new URLSearchParams({ artifact: kind });
  if (descriptor.digest) params.set('digest', String(descriptor.digest));

  const base = machineBaseUrl(name);
  return {
    entry: `machinen+pull+${base}?${params.toString()}`,
    manifestUrl: `${base}/mf-manifest.json`,
    descriptor,
  };
}

const artifactHost = process.env.ARTIFACT_HOST ?? '127.0.0.1';
const endpoint = await startArtifactEndpoint({
  layoutDir: registryDir,
  hostname: artifactHost,
  port: Number(process.env.ARTIFACT_PORT ?? 0),
});
artifactBaseUrl = (process.env.ARTIFACT_BASE_URL ?? endpoint.url).replace(/\/+$/, '');

const guest = createGuestRuntime({
  name: 'artifact_machine',
  version: '1.0.0',
  metaData: {
    registryDir,
    artifactBaseUrl,
  },
  exposes: {
    './registry': {
      listMachines: {
        handler: listMachines,
        params: [],
        returns: '{ name: string; version: string; artifacts: string[]; manifestUrl: string }[]',
      },
      getManifest: {
        handler: getManifest,
        params: [{ name: 'name', type: 'string' }],
        returns: 'unknown',
      },
      getArtifactDescriptor: {
        handler: getArtifactDescriptor,
        params: [
          { name: 'name', type: 'string' },
          { name: 'artifact', type: '"image" | "snapshot" | "vmstate"' },
        ],
        returns:
          '{ href: string; format: string; digest?: string; ext?: string; mediaType?: string; bytes?: number; platform?: string } | null',
      },
      resolvePullEntry: {
        handler: resolvePullEntry,
        params: [
          { name: 'name', type: 'string' },
          { name: 'artifact', type: '"image" | "snapshot" | "vmstate"' },
        ],
        returns:
          '{ entry: string; manifestUrl: string; descriptor: { href: string; format: string; digest?: string; ext?: string; mediaType?: string; bytes?: number; platform?: string } }',
      },
    },
  },
});

const port = Number(process.env.PORT ?? 3807);
const server = await serveGuest(guest, { port, imagePath: process.argv[1] });
console.log(
  `[machine-artifact] registry machine listening on 127.0.0.1:${server.port}; artifacts at ${artifactBaseUrl}`,
);

async function shutdown() {
  await Promise.allSettled([server.close(), endpoint.close()]);
}

process.once('SIGINT', async () => {
  await shutdown();
  process.exit(0);
});
process.once('SIGTERM', async () => {
  await shutdown();
  process.exit(0);
});
