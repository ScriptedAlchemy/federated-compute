// Boot once, run everywhere — the Machinen story through Module Federation.
//
// Scenario 1 (cold): federation boots machines from images, works them warm.
// Scenario 2 (unfreeze): the warm machines are snapshotted; a brand-new
// federation host then points its entries at the snapshots — loading the
// remote IS restoring the machine, which continues exactly where it left off.
//
// The process driver simulates the freeze at application-state level; with
// @machinen/runtime the same driver interface snapshots the whole microVM
// (memory, open files, timers).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMachines } from '../packages/runtime-plugin/dist/client.js';
import { processDriver } from '../packages/runtime-plugin/dist/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = 'snap-secret';

const images = {
  compute_machine: path.join(ROOT, 'apps/remote/dist/index.js'),
  java_machine: path.join(ROOT, 'apps/remote-java/dist/java-machine.jar'),
  python_machine: path.join(ROOT, 'apps/remote-python/main.py'),
};

console.log('=== Scenario 1: boot once (cold boot from images) ===');
const hostA = createMachines({
  driver: processDriver({ snapshotDir: path.join(ROOT, '.machinen/snapshots') }),
  remotes: Object.fromEntries(
    Object.entries(images).map(([name, image]) => [name, `machinen://${image}?token=${token}`]),
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
      `machinen://${snap.snapFile}?token=${token}`,
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
