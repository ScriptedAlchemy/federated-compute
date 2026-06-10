import http from 'node:http';
import { afterAll, describe, expect, test } from 'vitest';
import {
  bindingExportNames,
  fetchBindingsSource,
  fetchMachineManifest,
  generateBarrel,
  generateBindings,
} from '../src/bindgen.js';
import { createGuestRuntime, serveGuest, type GuestServer } from '../src/guest.js';
import type { MachineExposeManifest } from '../src/types.js';

const manifest: MachineExposeManifest = {
  name: 'java_machine',
  protocol: 3,
  version: '1.0.0',
  exposes: {
    './strings': {
      upper: { params: [{ name: 's', type: 'string' }], returns: 'string' },
      sha256: { params: [{ name: 's', type: 'string' }], returns: 'string' },
    },
    './compute': {
      primesBelow: { params: [{ name: 'n', type: 'number' }], returns: 'number[]' },
      countdown: {
        params: [{ name: 'from', type: 'number' }],
        returns: 'number',
        stream: true,
      },
    },
  },
};

describe('generateBindings', () => {
  test('emits one interface per exposed module plus a module map', () => {
    const src = generateBindings(manifest);

    expect(src).toContain('export interface JavaMachineStrings {');
    expect(src).toContain('upper(s: string): Promise<string>;');
    expect(src).toContain('sha256(s: string): Promise<string>;');
    expect(src).toContain('export interface JavaMachineCompute {');
    expect(src).toContain('primesBelow(n: number): Promise<number[]>;');
    // Streaming functions return async iterables, not promises.
    expect(src).toContain('countdown(from: number): AsyncIterable<number>;');
    expect(src).toContain("'./strings': JavaMachineStrings;");
    expect(src).toContain("'./compute': JavaMachineCompute;");
    expect(src).toContain('export interface JavaMachineModules {');
  });

  test('emits ready-to-import lazy module bindings for end users', () => {
    const src = generateBindings(manifest);

    expect(src).toContain(
      "import { machineModule } from '@federated-compute/machinen-plugin/client';",
    );
    // import { strings } from './java_machine' — call strings.upper(...) directly.
    expect(src).toContain(
      "export const strings = machineModule<JavaMachineStrings>('java_machine', './strings', { version: '^1.0.0' });",
    );
    expect(src).toContain(
      "export const compute = machineModule<JavaMachineCompute>('java_machine', './compute', { version: '^1.0.0', streams: ['countdown'] });",
    );
  });

  test('emits streams metadata only for modules with streaming functions', () => {
    const src = generateBindings(manifest);

    // './compute' has a streaming function, './strings' is purely unary.
    expect(src).toContain("'./compute', { version: '^1.0.0', streams: ['countdown'] }");
    expect(src).toContain("'./strings', { version: '^1.0.0' }");
    expect(src).not.toContain("'./strings', { version: '^1.0.0', streams");
  });

  test('reserved-word expose paths from foreign manifests still emit legal export names', () => {
    // Foreign guests may not run our validation; bindgen must not emit
    // `export const delete = ...`.
    const src = generateBindings({
      name: 'edge_machine',
      protocol: 3,
      version: '1.0.0',
      exposes: { './delete': { it: { params: [], returns: 'boolean' } } },
    });
    expect(src).toContain('export const delete_ = machineModule<EdgeMachineDelete>');
    expect(src).not.toMatch(/export const delete =/);
  });

  test('digit-leading machine names and expose paths still emit legal TS names', () => {
    // pascalCase('3com-machine') keeps the leading digit — invalid as an
    // interface name; the export identifier for './3d' has the same problem.
    const src = generateBindings({
      name: '3com-machine',
      protocol: 3,
      version: '1.0.0',
      exposes: { './3d': { render: { params: [], returns: 'string' } } },
    });
    expect(src).toContain('export interface M3comMachine3d {');
    expect(src).toContain('export interface M3comMachineModules {');
    expect(src).toContain('export const _3d = machineModule<M3comMachine3d>');
    expect(src).not.toMatch(/export (interface|const) 3/);
  });
});

describe('fetchBindingsSource (host-side, network only)', () => {
  const servers: GuestServer[] = [];
  const rawServers: http.Server[] = [];
  afterAll(async () => {
    await Promise.all(servers.map((s) => s.close()));
    for (const s of rawServers) s.close();
  });

  test('prefers the machine-published /mf-types.ts artifact', async () => {
    const guest = createGuestRuntime({
      name: 'types_machine',
      version: '1.0.0',
      exposes: { './math': { add: { handler: (a: number, b: number) => a + b, returns: 'number' } } },
    });
    const server = await serveGuest(guest, { port: 0 });
    servers.push(server);

    const source = await fetchBindingsSource(`http://127.0.0.1:${server.port}`);
    expect(source).toContain('export interface TypesMachineMath {');
  });

  test('falls back to rendering from the manifest when the machine serves no types', async () => {
    // A machine that only publishes its manifest (e.g. the Java/Python guests).
    const server = http.createServer((req, res) => {
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

    const source = await fetchBindingsSource(`http://127.0.0.1:${port}`);
    expect(source).toContain('export interface JavaMachineStrings {');
    expect(source).toContain("machineModule<JavaMachineStrings>('java_machine', './strings'");
  });

  test('rejects manifest fallbacks that speak a different protocol version', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/mf-manifest.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...manifest, protocol: 2 }));
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

    await expect(fetchBindingsSource(`http://127.0.0.1:${port}`)).rejects.toThrow(
      /guest protocol 2, expected 3/,
    );
  });
});

describe('barrel generation', () => {
  test('bindingExportNames returns sorted legal identifiers for expose paths', () => {
    expect(
      bindingExportNames({
        name: 'edge_machine',
        protocol: 3,
        version: '1.0.0',
        exposes: {
          './delete': { it: { params: [], returns: 'boolean' } },
          './math': { add: { params: [], returns: 'number' } },
        },
      }),
    ).toEqual(['delete_', 'math']);
  });

  test('emits a namespace export per machine plus flat re-exports for unique names', () => {
    const src = generateBarrel([
      { name: 'compute_machine', exportNames: ['counter', 'math'] },
      { name: 'java_machine', exportNames: ['counter', 'strings'] },
    ]);
    expect(src).toContain("export * as compute_machine from './compute_machine';");
    expect(src).toContain("export * as java_machine from './java_machine';");
    // Unique names re-export flat; colliding ones (counter) only via namespaces.
    expect(src).toContain("export { math } from './compute_machine';");
    expect(src).toContain("export { strings } from './java_machine';");
    expect(src).not.toMatch(/export \{[^}]*\bcounter\b[^}]*\}/);
  });

  test('is deterministic regardless of input order', () => {
    const a = generateBarrel([
      { name: 'b_machine', exportNames: ['beta'] },
      { name: 'a_machine', exportNames: ['alpha'] },
    ]);
    const b = generateBarrel([
      { name: 'a_machine', exportNames: ['alpha'] },
      { name: 'b_machine', exportNames: ['beta'] },
    ]);
    expect(a).toBe(b);
    expect(a.indexOf('a_machine')).toBeLessThan(a.indexOf('b_machine'));
  });
});

describe('fetchMachineManifest', () => {
  const servers: GuestServer[] = [];
  afterAll(async () => {
    await Promise.all(servers.map((s) => s.close()));
  });

  test('fetches and validates a protocol-3 manifest', async () => {
    const guest = createGuestRuntime({
      name: 'manifest_machine',
      version: '1.0.0',
      exposes: { './math': { add: { handler: (a: number, b: number) => a + b, returns: 'number' } } },
    });
    const server = await serveGuest(guest, { port: 0 });
    servers.push(server);
    const manifest = await fetchMachineManifest(`http://127.0.0.1:${server.port}`);
    expect(manifest.name).toBe('manifest_machine');
    expect(manifest.protocol).toBe(3);
  });
});
