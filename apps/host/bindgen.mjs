// Host-owned bindgen: pull types from DEPLOYED machines, exactly like MF
// hosts pull @mf-types from a remote's URL. This app knows only addresses
// (its own config/env) — it never reads another repo's source or disk.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchBindingsSource } from '@federated-compute/machinen-plugin';

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'src/generated');
const token = process.env.MACHINEN_TOKEN;

const machines = {
  compute_machine: process.env.MACHINEN_REMOTE_COMPUTE_MACHINE ?? 'machinen+http://127.0.0.1:3801',
  java_machine: process.env.MACHINEN_REMOTE_JAVA_MACHINE ?? 'machinen+http://127.0.0.1:3802',
  python_machine: process.env.MACHINEN_REMOTE_PYTHON_MACHINE ?? 'machinen+http://127.0.0.1:3803',
};

await mkdir(OUT_DIR, { recursive: true });
for (const [name, entry] of Object.entries(machines)) {
  const url = entry.replace(/^machinen\+/, '').split('?')[0];
  const source = await fetchBindingsSource(url, { token });
  const file = path.join(OUT_DIR, `${name}.ts`);
  await writeFile(file, source);
  console.log(`[host bindgen] ${url} -> src/generated/${name}.ts`);
}
