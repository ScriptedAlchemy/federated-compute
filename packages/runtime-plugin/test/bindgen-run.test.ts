import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { runBindgenFromConfig } from '../src/bindgen-run.js';
import type { MachinenConfig } from '../src/config.js';
import { createGuestRuntime, serveGuest, type GuestServer } from '../src/guest.js';

const servers: GuestServer[] = [];
const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

async function startGuest(name: string, opts: { token?: string } = {}): Promise<GuestServer> {
  const guest = createGuestRuntime({
    name,
    version: '1.0.0',
    exposes: {
      './math': { add: { handler: (a: number, b: number) => a + b, returns: 'number' } },
      './counter': { current: { handler: () => 0, returns: 'number' } },
    },
  });
  const server = await serveGuest(guest, { port: 0, token: opts.token });
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

  test('a ?token= on the config entry authenticates against a token-requiring guest', async () => {
    const guest = await startGuest('entry_token_machine', { token: 'sesame' });
    const config = makeConfig({
      entry_token_machine: { url: `machinen+http://127.0.0.1:${guest.port}?token=sesame` },
    });

    const result = await runBindgenFromConfig(config, {});
    expect(result.ok).toBe(true);
    expect(result.machines[0].status).toBe('written');
  });

  test('options.token wins over a wrong ?token= on the entry', async () => {
    const guest = await startGuest('option_token_machine', { token: 'sesame' });
    const config = makeConfig({
      option_token_machine: { url: `machinen+http://127.0.0.1:${guest.port}?token=wrong` },
    });

    // Sanity: the entry token alone is rejected by the guest.
    const denied = await runBindgenFromConfig(config, {});
    expect(denied.ok).toBe(false);
    expect(denied.machines[0].status).toBe('error');

    const result = await runBindgenFromConfig(config, { token: 'sesame' });
    expect(result.ok).toBe(true);
    expect(result.machines[0].status).toBe('written');
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
});
