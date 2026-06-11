import http from 'node:http';
import { afterAll, describe, expect, test } from 'vitest';
import { createInstance } from '@module-federation/runtime';
import { DEFAULT_POLICY, machinenPlugin, MachineVersionError } from '../src/index.js';
import { resolvePullEntry } from '../src/artifacts.js';
import { DEFAULT_POLICY as POLICY_MODULE_DEFAULT } from '../src/policy.js';
import { parseMachineEntry, type MachineExposeManifest } from '../src/types.js';

/**
 * Deferred review findings around the public error/policy surface: hosts
 * must be able to read version negotiation results from structured fields
 * (not regex-scrape prose) and compute breaker thresholds from the exported
 * default policy (not hard-code threshold+1).
 */

const rawServers: http.Server[] = [];
afterAll(async () => {
  for (const server of rawServers) server.close();
});

function listen(server: http.Server): Promise<number> {
  rawServers.push(server);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
  );
}

describe('MachineVersionError carries structured fields', () => {
  test('pull rejection: required and reported are readable without parsing the message', async () => {
    const manifest: MachineExposeManifest = {
      name: 'stub_machine',
      protocol: 3,
      version: '1.0.0',
      exposes: { './counter': { current: { params: [], returns: 'number' } } },
    };
    const server = http.createServer((req, res) => {
      if (req.url === '/mf-manifest.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(manifest));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const port = await listen(server);

    const spec = parseMachineEntry(
      'stub_machine',
      `machinen+pull+http://127.0.0.1:${port}?version=^2.0.0`,
    );
    const error = (await resolvePullEntry(spec).catch((e: unknown) => e)) as MachineVersionError;

    expect(error).toBeInstanceOf(MachineVersionError);
    expect(error.required).toBe('^2.0.0');
    expect(error.reported).toBe('1.0.0');
    // The prose is unchanged — the fields are additive.
    expect(error.message).toMatch(/required "\^2\.0\.0", origin reports "1\.0\.0"/);
  });

  test('attach rejection: the booted machine version mismatch carries both fields', async () => {
    const remote = { name: 'versioned_machine', entry: 'machinen://images/v.img?version=^9.0.0' };
    const plugin = machinenPlugin({
      driver: {
        boot: async () => ({
          manifest: async () => ({
            name: remote.name,
            protocol: 3,
            version: '2.0.0',
            exposes: { './svc': { run: { params: [], returns: 'string' } } },
          }),
          call: async () => 'never',
        }),
      },
    });
    const host = createInstance({ name: 'host_versioned', remotes: [remote], plugins: [plugin] });

    const error = (await host
      .loadRemote(`${remote.name}/svc`)
      .catch((e: unknown) => e)) as MachineVersionError;

    expect(error).toBeInstanceOf(MachineVersionError);
    expect(error.required).toBe('^9.0.0');
    expect(error.reported).toBe('2.0.0');
  });

  test('a missing/invalid manifest version reports the raw value', async () => {
    const remote = { name: 'unversioned_machine', entry: 'machinen://images/u.img?version=^1.0.0' };
    const plugin = machinenPlugin({
      driver: {
        boot: async () => ({
          manifest: async () => ({
            name: remote.name,
            protocol: 3,
            version: 'not-semver',
            exposes: { './svc': { run: { params: [], returns: 'string' } } },
          }),
          call: async () => 'never',
        }),
      },
    });
    const host = createInstance({ name: 'host_unversioned', remotes: [remote], plugins: [plugin] });

    const error = (await host
      .loadRemote(`${remote.name}/svc`)
      .catch((e: unknown) => e)) as MachineVersionError;

    expect(error).toBeInstanceOf(MachineVersionError);
    expect(error.required).toBe('^1.0.0');
    expect(error.reported).toBe('not-semver');
  });
});

describe('DEFAULT_POLICY is part of the package surface', () => {
  test('the index export exists and is the policy the plugin uses', () => {
    expect(DEFAULT_POLICY).toBe(POLICY_MODULE_DEFAULT);
    expect(DEFAULT_POLICY.circuitBreaker).toEqual({ threshold: 5, resetMs: 10_000 });
    expect(DEFAULT_POLICY.timeoutMs).toBe(30_000);
  });
});
