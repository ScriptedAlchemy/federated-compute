// The real thing, no fakes: this demo drives ACTUAL machinen microVMs (KVM)
// through the full federation stack. A `machinen://` entry pointing at the
// repo's Node guest bundle boots a real VM (debian base + node installed
// inside, ~10s), counter calls flow host -> federation bindings -> gvproxy
// port forward -> guest protocol v3 inside the VM. The warm VM is then frozen
// into a whole-VM vmstate snapshot (~2.5GB: RAM + rootdisk + vCPU state),
// killed, and a SECOND federation client whose entry is the snapshot
// directory restores it — the counter continues from in-VM process heap.
//
// Requires Linux with usable /dev/kvm (or Apple Silicon) and machinen base
// assets (`pnpm exec machinen install`, fetched automatically on first boot).
//
// Disk note: this script plays the DEPLOYMENT-OWNER role — it boots its own
// guest bundle and restores its own vmstate dir, like any deployment. Moving
// vmstate BETWEEN machines over HTTP is Phase 2 (see the vmstate federation
// spec); the app-state HTTP move exists today via machinen+pull+http://.
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMachines } from '../packages/runtime-plugin/dist/client.js';
import { machinenDriver } from '../packages/runtime-plugin/dist/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUEST_BUNDLE = path.join(ROOT, 'apps/remote/dist/index.js');

if (!existsSync(GUEST_BUNDLE)) {
  console.error(`guest bundle missing at ${GUEST_BUNDLE} — run \`pnpm --filter remote build\` first`);
  process.exit(1);
}
if (process.platform === 'linux' && !existsSync('/dev/kvm')) {
  console.error('no /dev/kvm on this host — the real machinen driver needs KVM');
  process.exit(1);
}

const snapshotDir = await mkdtemp(path.join(os.tmpdir(), 'machinen-demo-'));
const timings = {};
const since = (t0) => `${Date.now() - t0}ms`;
let hostA;
let hostB;

try {
  console.log('=== Act 1: federation boots a REAL microVM ===');
  const driver = machinenDriver({ snapshotDir });
  hostA = createMachines({
    driver,
    bootTimeoutMs: 180_000,
    remotes: { compute_machine: `machinen://${GUEST_BUNDLE}` },
  });

  let t0 = Date.now();
  const counterA = hostA.machine('compute_machine').counter;
  const one = await counterA.increment(); // first call boots the VM
  timings.coldBootAndFirstCall = since(t0);
  console.log(`  first call booted the VM and returned counter=${one} (${timings.coldBootAndFirstCall})`);

  t0 = Date.now();
  await counterA.increment();
  const three = await counterA.increment();
  timings.twoWarmCalls = since(t0);
  console.log(`  two warm calls -> counter=${three} (${timings.twoWarmCalls} for both, VM stays hot)`);

  console.log('\n=== Act 2: freeze the whole VM (RAM + disk + vCPUs) ===');
  t0 = Date.now();
  const snap = await hostA.plugin.snapshotMachine('compute_machine');
  timings.snapshot = since(t0);
  console.log(`  snapshot bundle: ${snap.snapDir} (${timings.snapshot})`);

  await hostA.plugin.disposeMachines();
  hostA = undefined;
  console.log('  source VM killed. counter=3 now lives ONLY in the snapshot bundle.');

  console.log('\n=== Act 3: a second client restores the VM from the bundle ===');
  hostB = createMachines({
    driver: machinenDriver({ snapshotDir }),
    bootTimeoutMs: 180_000,
    remotes: { compute_machine: `machinen://${snap.snapDir}` },
  });

  t0 = Date.now();
  const counterB = hostB.machine('compute_machine').counter;
  const resumed = await counterB.current(); // first call restores the VM
  timings.restoreAndFirstCall = since(t0);
  const four = await counterB.increment();
  console.log(`  restored VM reports counter=${resumed}, continues -> ${four} (restore+call ${timings.restoreAndFirstCall})`);

  if (resumed !== 3 || four !== 4) {
    throw new Error(`counter did NOT continue across the VM snapshot/restore: got ${resumed} -> ${four}`);
  }

  await hostB.plugin.disposeMachines();
  hostB = undefined;

  console.log('\n=== Verdict ===');
  console.log('  The counter went 1,2,3 in one VM, was frozen mid-heap, and continued 3 -> 4');
  console.log('  in a VM restored by a different federation client. Boot once, run everywhere —');
  console.log('  with real microVMs, not local child processes.');
  console.log(
    `  timings: cold boot+call ${timings.coldBootAndFirstCall}, warm calls ${timings.twoWarmCalls}, ` +
      `snapshot ${timings.snapshot}, restore+call ${timings.restoreAndFirstCall}`,
  );
} finally {
  // Kill by handle (disposeMachines -> vm.kill); reclaim the ~2.5GB bundle.
  await hostA?.plugin.disposeMachines().catch(() => {});
  await hostB?.plugin.disposeMachines().catch(() => {});
  await rm(snapshotDir, { recursive: true, force: true });
}
