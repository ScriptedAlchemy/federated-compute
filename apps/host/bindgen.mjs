// Host-owned bindgen: pull types from deployed machine addresses only —
// the @mf-types flow for machines.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchBindingsSource, parseMachineEntry } from '@federated-compute/machinen-plugin';

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'src/generated');
const token = process.env.MACHINEN_TOKEN;

const machines = {
  compute_machine: process.env.MACHINEN_REMOTE_COMPUTE_MACHINE ?? 'machinen+http://127.0.0.1:3801',
  java_machine: process.env.MACHINEN_REMOTE_JAVA_MACHINE ?? 'machinen+http://127.0.0.1:3802',
  python_machine: process.env.MACHINEN_REMOTE_PYTHON_MACHINE ?? 'machinen+http://127.0.0.1:3803',
  db_machine: process.env.MACHINEN_REMOTE_DB_MACHINE ?? 'machinen+http://127.0.0.1:3804',
  analytics_machine:
    process.env.MACHINEN_REMOTE_ANALYTICS_MACHINE ?? 'machinen+http://127.0.0.1:3805',
};

await mkdir(OUT_DIR, { recursive: true });
for (const [name, entry] of Object.entries(machines)) {
  const { url } = parseMachineEntry(name, entry);
  const source = await fetchBindingsSource(url, { token });
  const file = path.join(OUT_DIR, `${name}.ts`);
  await writeFile(file, source);
  console.log(`[host bindgen] ${url} -> src/generated/${name}.ts`);
}
