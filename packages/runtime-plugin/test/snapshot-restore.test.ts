import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { getFreePort, processDriver } from '../src/drivers/process.js';
import { parseMachineEntry } from '../src/types.js';

const PYTHON_GUEST = path.resolve(import.meta.dirname, '../../../apps/remote-python/main.py');
const hasPython = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status !== null;

const disposers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const dispose of disposers) await dispose();
});

describe.skipIf(!hasPython)('boot once, run everywhere (process-driver snapshot/restore)', () => {
  test('a snapshot restores on a "different host" with state intact', { timeout: 60_000 }, async () => {
    const snapshotDir = await mkdtemp(path.join(os.tmpdir(), 'machinen-snap-'));
    const driver = processDriver({ snapshotDir });

    // Boot cold from the image and accumulate state.
    const portA = await getFreePort();
    const specA = parseMachineEntry(
      'py_machine',
      `machinen://${PYTHON_GUEST}?port=${portA}&token=snap-secret`,
    );
    const machineA = await driver.boot(specA);
    disposers.push(() => machineA.dispose?.());
    await machineA.call('./counter', 'increment', []);
    await machineA.call('./counter', 'increment', []);
    await machineA.call('./counter', 'increment', []);

    // Freeze: snapshot bundles the state with the image reference,
    // like Machinen's snapshot bundles remember their rootfs tarball.
    const snapshot = (await machineA.snapshot!()) as { snapFile: string };
    expect(snapshot.snapFile).toContain(snapshotDir);
    expect(snapshot.snapFile.endsWith('.snap')).toBe(true);
    const bundle = JSON.parse(await readFile(snapshot.snapFile, 'utf8'));
    expect(bundle.image).toBe(PYTHON_GUEST);
    expect(bundle.state).toEqual({ counter: 3 });
    await machineA.dispose?.();

    // "Another host": restore from the snapshot — the machine continues
    // from the same state instead of starting over.
    const portB = await getFreePort();
    const specB = parseMachineEntry(
      'py_machine',
      `machinen://${snapshot.snapFile}?port=${portB}&token=snap-secret`,
    );
    const machineB = await driver.boot(specB);
    disposers.push(() => machineB.dispose?.());

    await expect(machineB.call('./counter', 'current', [])).resolves.toBe(3);
    await expect(machineB.call('./counter', 'increment', [])).resolves.toBe(4);
  });
});
