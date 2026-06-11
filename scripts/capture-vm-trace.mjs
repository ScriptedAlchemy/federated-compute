// Drive the live /api/vm/* routes against a running demo host (KVM required)
// and record a replayable trace: every UI-visible state, on a relative
// timeline, from real runs only. Exits 78 (machinen-e2e convention) when the
// host reports the live track unavailable.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.VM_TRACE_BASE ?? 'http://127.0.0.1:3800';
const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../apps/host/vm-trace.json',
);

const t0 = Date.now();
const events = [];
const record = (kind, body) => events.push({ atMs: Date.now() - t0, kind, ...body });

async function api(method, route) {
  const res = await fetch(`${BASE}${route}`, { method });
  const body = await res.json();
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status}: ${body.error ?? ''}`);
  return body;
}

const capability = await api('GET', '/api/vm/capability');
if (!capability.available) {
  console.error(`machinen-unavailable: ${capability.detail}`);
  process.exit(78);
}

record('boot-start', {});
const boot = await api('POST', '/api/vm/boot');
record('running', { state: boot });

// Let the solver visibly work; sample progress like the UI poller would.
for (let i = 0; i < 8; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const state = await api('GET', '/api/vm/state');
  record('progress', { progress: state.progress });
}

record('publish-start', {});
const published = await api('POST', '/api/vm/publish');
record('published', { state: published });

record('restore-start', {});
const restored = await api('POST', '/api/vm/restore');
record('restored', { state: restored });

for (let i = 0; i < 4; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const state = await api('GET', '/api/vm/state');
  record('progress', { progress: state.progress });
}

await api('POST', '/api/vm/reset');

await writeFile(
  OUT,
  JSON.stringify(
    {
      format: 'vm-demo-trace@1',
      capturedAt: new Date().toISOString(),
      platform: capability.platform,
      runtime: capability.runtime,
      events,
    },
    null,
    2,
  ),
);
console.log(`trace written: ${OUT} (${events.length} events)`);
