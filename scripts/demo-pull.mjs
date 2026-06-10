// Fork-by-fetch, no hypervisor: pull federation makes the machine's IMAGE
// and warm SNAPSHOT the federated artifact — the missing remoteEntry.js leg
// of the MF analogy. An origin machine publishes itself (/mf-image,
// /mf-snapshot); a consumer's `machinen+pull+http://...` entry fetches the
// artifact into a digest-addressed cache and boots an INDEPENDENT clone
// through the ordinary process driver.
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMachines } from '../packages/runtime-plugin/dist/client.js';
import { getFreePort, processDriver } from '../packages/runtime-plugin/dist/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUEST_BUNDLE = path.join(ROOT, 'apps/remote/dist/index.js');

if (!existsSync(GUEST_BUNDLE)) {
  console.error(`guest bundle missing at ${GUEST_BUNDLE} — run \`pnpm --filter remote build\` first`);
  process.exit(1);
}

const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'machinen-pull-cache-'));
const hosts = [];

function telemetry(machines, label) {
  machines.plugin.machineHooks.onArtifactFetched.on(({ resolution }) => {
    console.log(
      `  [${label}] pulled ${resolution.artifact}: ` +
        `${resolution.fromCache ? 'cache HIT (0 bytes moved)' : `${resolution.bytesFetched} bytes fetched`} ` +
        `in ${resolution.durationMs}ms -> ${path.relative(ROOT, resolution.localPath)}`,
    );
  });
}

try {
  console.log('=== Act 1: an origin machine publishes itself ===');
  const originPort = await getFreePort();
  const origin = createMachines({
    driver: processDriver(),
    remotes: { compute_machine: `machinen://${GUEST_BUNDLE}?port=${originPort}` },
  });
  hosts.push(origin);

  const originCounter = origin.machine('compute_machine').counter;
  await originCounter.increment();
  await originCounter.increment();
  const worked = await originCounter.increment();
  console.log(`  origin warm at 127.0.0.1:${originPort}, counter = ${worked}`);
  const manifest = await (await fetch(`http://127.0.0.1:${originPort}/mf-manifest.json`)).json();
  console.log(
    `  origin manifest publishes artifacts: image (${manifest.artifacts.image.digest.slice(0, 19)}..., ` +
      `${manifest.artifacts.image.bytes} bytes) + snapshot (${manifest.artifacts.snapshot.format})`,
  );

  console.log('\n=== Act 2: fork-by-fetch — a consumer pulls a WARM clone ===');
  const forker = createMachines({
    driver: processDriver(),
    artifactCacheDir: cacheDir,
    remotes: {
      compute_machine: `machinen+pull+http://127.0.0.1:${originPort}?artifact=snapshot&version=^1.0.0`,
    },
  });
  hosts.push(forker);
  telemetry(forker, 'fork host');

  const clone = forker.machine('compute_machine').counter;
  const resumed = await clone.current(); // first call pulls + boots the clone
  const cloneNext = await clone.increment();
  console.log(`  clone resumed at counter=${resumed}, continued -> ${cloneNext}`);

  const originAfter = await originCounter.current();
  const originNext = await originCounter.increment();
  console.log(`  origin unaffected: still ${originAfter}, continues independently -> ${originNext}`);
  if (resumed !== 3 || cloneNext !== 4 || originAfter !== 3) {
    throw new Error(`fork-by-fetch state did not behave: clone ${resumed}->${cloneNext}, origin ${originAfter}`);
  }

  console.log('\n=== Act 3: cold pull — the image alone, like fetching remoteEntry.js ===');
  const colder = createMachines({
    driver: processDriver(),
    artifactCacheDir: cacheDir,
    remotes: {
      compute_machine: `machinen+pull+http://127.0.0.1:${originPort}?artifact=image`,
    },
  });
  hosts.push(colder);
  telemetry(colder, 'cold host');

  const fresh = colder.machine('compute_machine').counter;
  const freshStart = await fresh.current(); // image already in cache from Act 2
  const freshNext = await fresh.increment();
  console.log(`  cold clone booted from the cached image: counter ${freshStart} -> ${freshNext}`);
  if (freshStart !== 0 || freshNext !== 1) {
    throw new Error(`cold image pull leaked state: ${freshStart} -> ${freshNext}`);
  }

  const cached = await readdir(cacheDir);
  console.log(`\n  cache (${path.basename(cacheDir)}): ${cached.join(', ')}`);
  console.log('\n=== Verdict ===');
  console.log('  The machine itself was the federated artifact: one pull cloned a warm');
  console.log('  heap mid-count (3 -> 4 while the origin diverged on its own), another');
  console.log('  booted the cold image from the digest cache without re-downloading.');
  console.log('  remoteEntry.js for processes — fetched, verified, booted.');
} finally {
  for (const host of hosts) await host.plugin.disposeMachines().catch(() => {});
  await rm(cacheDir, { recursive: true, force: true });
}
