// Boot once, run everywhere: cold-boot machines, work them warm, snapshot,
// then a fresh federation host restores them from the snapshots mid-state.
// This is the app-state flavor (process driver, tiny .snap bundles, instant);
// demo-machinen.mjs runs the same story on real microVMs with whole-VM dumps.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMachines } from '../packages/runtime-plugin/dist/client.js';
import { processDriver } from '../packages/runtime-plugin/dist/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const images = {
  compute_machine: path.join(ROOT, 'apps/remote/dist/index.js'),
  java_machine: path.join(ROOT, 'apps/remote-java/dist/java-machine.jar'),
  python_machine: path.join(ROOT, 'apps/remote-python/main.py'),
};

console.log('=== Scenario 1: boot once (cold boot from images) ===');
const hostA = createMachines({
  driver: processDriver({ snapshotDir: path.join(ROOT, '.machinen/snapshots') }),
  remotes: Object.fromEntries(
    Object.entries(images).map(([name, image]) => [name, `machinen://${image}`]),
  ),
});

const snapshots = {};
for (const name of Object.keys(images)) {
  const counter = hostA.machine(name).counter;
  await counter.increment();
  await counter.increment();
  const value = await counter.increment();
  console.log(`  ${name}: worked the machine, counter = ${value}`);
  snapshots[name] = await hostA.plugin.snapshotMachine(name);
  console.log(`  ${name}: frozen -> ${path.relative(ROOT, snapshots[name].snapFile)}`);
}
await hostA.plugin.disposeMachines();
console.log('  all machines killed. State lives only in the snapshot bundles.\n');

console.log('=== Scenario 2: run everywhere (federation unfreezes machines) ===');
const hostB = createMachines({
  driver: processDriver(),
  remotes: Object.fromEntries(
    Object.entries(snapshots).map(([name, snap]) => [
      name,
      `machinen://${snap.snapFile}`,
    ]),
  ),
});

for (const name of Object.keys(snapshots)) {
  const counter = hostB.machine(name).counter;
  const resumed = await counter.current();
  const next = await counter.increment();
  console.log(`  ${name}: restored with counter = ${resumed}, continues -> ${next}`);
}
await hostB.plugin.disposeMachines();

console.log('\nBoot once, run everywhere: loadRemote() unfroze the machines.');
