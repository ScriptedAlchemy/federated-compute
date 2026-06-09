// Bindgen: fetch each machine's typed manifest and generate TS interfaces for
// the host. In a real deployment this would point at the machines' deployed
// URLs (like fetching MF remote types); locally it boots them briefly.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateBindings } from '../packages/runtime-plugin/dist/bindgen.js';
import { startMachines } from './machines.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'apps/host/src/generated');
const token = process.env.MACHINEN_TOKEN ?? 'bindgen-secret';

const { machines, stop } = await startMachines({ token });
try {
  await mkdir(OUT_DIR, { recursive: true });
  for (const machine of machines) {
    const file = path.join(OUT_DIR, `${machine.name}.ts`);
    await writeFile(file, generateBindings(machine.manifest));
    console.log(`[bindgen] wrote ${path.relative(ROOT, file)}`);
  }
} finally {
  stop();
}
