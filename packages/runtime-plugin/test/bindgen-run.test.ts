import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { runBindgenFromConfig } from '../src/bindgen-run.js';
import type { MachinenConfig } from '../src/config.js';
import { createGuestRuntime, serveGuest, type GuestServer } from '../src/guest.js';
import type { MachineExposeManifest } from '../src/types.js';

const servers: GuestServer[] = [];
const rawServers: http.Server[] = [];
const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
  for (const s of rawServers) s.close();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

async function startGuest(name: string): Promise<GuestServer> {
  const guest = createGuestRuntime({
    name,
    version: '1.0.0',
    exposes: {
      './math': { add: { handler: (a: number, b: number) => a + b, returns: 'number' } },
      './counter': { current: { handler: () => 0, returns: 'number' } },
    },
  });
  const server = await serveGuest(guest, { port: 0 });
  servers.push(server);
  return server;
}

function makeConfig(machines: MachinenConfig['machines']): MachinenConfig {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'machinen-bindgen-run-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'machinen.config.json');
  writeFileSync(file, JSON.stringify({ machines, bindgen: { outDir: 'src/generated' } }));
  return { path: file, dir, machines, bindgen: { outDir: 'src/generated' } };
}

describe('runBindgenFromConfig', () => {
  test('writes one binding file per machine plus an index.ts barrel', async () => {
    const a = await startGuest('alpha_machine');
    const b = await startGuest('beta_machine');
    const config = makeConfig({
      alpha_machine: { url: `machinen+http://127.0.0.1:${a.port}` },
      beta_machine: { url: `machinen+http://127.0.0.1:${b.port}` },
    });

    const result = await runBindgenFromConfig(config, {});
    expect(result.ok).toBe(true);
    const outDir = path.join(config.dir, 'src/generated');
    expect(readdirSync(outDir).sort()).toEqual(['alpha_machine.ts', 'beta_machine.ts', 'index.ts']);
    const barrel = readFileSync(path.join(outDir, 'index.ts'), 'utf8');
    expect(barrel).toContain("export * as alpha_machine from './alpha_machine';");
    // 'math' and 'counter' exist on both machines -> namespace-only.
    expect(barrel).not.toMatch(/export \{[^}]*\bmath\b/);
  });

  test('env var overrides the config url', async () => {
    const live = await startGuest('env_bind_machine');
    const config = makeConfig({
      env_bind_machine: { url: 'machinen+http://127.0.0.1:9' },
    });
    process.env.MACHINEN_REMOTE_ENV_BIND_MACHINE = `machinen+http://127.0.0.1:${live.port}`;
    try {
      const result = await runBindgenFromConfig(config, {});
      expect(result.ok).toBe(true);
    } finally {
      delete process.env.MACHINEN_REMOTE_ENV_BIND_MACHINE;
    }
  });

  test('an unreachable machine fails its entry but the rest still generate', async () => {
    const live = await startGuest('alive_machine');
    const config = makeConfig({
      alive_machine: { url: `machinen+http://127.0.0.1:${live.port}` },
      dead_machine: { url: 'machinen+http://127.0.0.1:9' },
    });

    const result = await runBindgenFromConfig(config, {});
    expect(result.ok).toBe(false);
    const byName = Object.fromEntries(result.machines.map((m) => [m.name, m]));
    expect(byName.alive_machine.status).toBe('written');
    expect(byName.dead_machine.status).toBe('error');
    expect(existsSync(path.join(config.dir, 'src/generated/alive_machine.ts'))).toBe(true);
  });

  test('check mode reports clean after a write and drift after an edit, writing nothing', async () => {
    const guest = await startGuest('check_machine');
    const config = makeConfig({
      check_machine: { url: `machinen+http://127.0.0.1:${guest.port}` },
    });
    await runBindgenFromConfig(config, {});

    const clean = await runBindgenFromConfig(config, { check: true });
    expect(clean.ok).toBe(true);
    expect(clean.machines.every((m) => m.status === 'clean')).toBe(true);

    const file = path.join(config.dir, 'src/generated/check_machine.ts');
    writeFileSync(file, '// drifted\n');
    const before = readFileSync(file, 'utf8');
    const drifted = await runBindgenFromConfig(config, { check: true });
    expect(drifted.ok).toBe(false);
    expect(drifted.machines.find((m) => m.name === 'check_machine')?.status).toBe('drift');
    // check mode never writes
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  test('prefers a machine-published /mf-types.ts artifact over manifest rendering', async () => {
    // A machine whose published types differ from what the manifest would
    // render — config mode must ship the artifact (like single-machine mode),
    // while the barrel still derives export names from the manifest.
    const manifest: MachineExposeManifest = {
      name: 'types_machine',
      protocol: 3,
      version: '1.0.0',
      exposes: { './math': { add: { params: [], returns: 'number' } } },
    };
    const published = '// MACHINE-PUBLISHED TYPES — richer than the manifest rendering\n';
    const server = http.createServer((req, res) => {
      if (req.url === '/mf-types.ts') {
        res.writeHead(200, { 'content-type': 'application/typescript' });
        res.end(published);
        return;
      }
      if (req.url === '/mf-manifest.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(manifest));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    rawServers.push(server);
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () =>
        resolve((server.address() as { port: number }).port),
      ),
    );

    const config = makeConfig({
      types_machine: { url: `machinen+http://127.0.0.1:${port}` },
    });
    const result = await runBindgenFromConfig(config, {});
    expect(result.ok).toBe(true);
    const outDir = path.join(config.dir, 'src/generated');
    expect(readFileSync(path.join(outDir, 'types_machine.ts'), 'utf8')).toBe(published);
    // Barrel export names still come from the manifest signatures.
    expect(readFileSync(path.join(outDir, 'index.ts'), 'utf8')).toContain(
      "export { math } from './types_machine';",
    );
  });

  test('write mode prunes stale generated binding files but preserves user files', async () => {
    const guest = await startGuest('prune_machine');
    const config = makeConfig({
      prune_machine: { url: `machinen+http://127.0.0.1:${guest.port}` },
    });
    await runBindgenFromConfig(config, {});
    const outDir = path.join(config.dir, 'src/generated');
    const stale = path.join(outDir, 'removed_machine.ts');
    const userFile = path.join(outDir, 'notes.ts');
    writeFileSync(stale, '// AUTO-GENERATED from an old machine by machinen bindgen.\nexport {};\n');
    writeFileSync(userFile, 'export const handwritten = true;\n');

    const result = await runBindgenFromConfig(config, {});

    expect(result.ok).toBe(true);
    expect(result.pruned).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);
    expect(readFileSync(userFile, 'utf8')).toBe('export const handwritten = true;\n');
  });

  test('check mode reports stale generated bindings without deleting any file', async () => {
    const guest = await startGuest('check_prune_machine');
    const config = makeConfig({
      check_prune_machine: { url: `machinen+http://127.0.0.1:${guest.port}` },
    });
    await runBindgenFromConfig(config, {});
    const outDir = path.join(config.dir, 'src/generated');
    const stale = path.join(outDir, 'removed_machine.ts');
    const userFile = path.join(outDir, 'notes.ts');
    writeFileSync(stale, '// AUTO-GENERATED from an old machine by machinen bindgen.\nexport {};\n');
    writeFileSync(userFile, 'export const handwritten = true;\n');

    const result = await runBindgenFromConfig(config, { check: true });

    expect(result.ok).toBe(false);
    expect(result.pruned).toEqual([stale]);
    expect(existsSync(stale)).toBe(true);
    expect(readFileSync(userFile, 'utf8')).toBe('export const handwritten = true;\n');
  });
});
