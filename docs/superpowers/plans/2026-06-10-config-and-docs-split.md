# machinen.config.json + Zero-Arg Bindgen + Docs Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One per-consumer `machinen.config.json` drives both `createMachines()` (zero-arg runtime) and `machinen-bindgen` (no-arg regen-all with barrel + `--check` drift mode); README splits into a slim quickstart plus focused docs.

**Architecture:** A new sync config loader in `@federated-compute/machinen-plugin` walks up from cwd to find `machinen.config.json`. The runtime client falls back to it (options > env > config). The bindgen CLI gains a config mode whose orchestration lives in a testable library module (`bindgen-run.ts`); the CLI stays a thin shell. The host app adopts the config and a generated barrel. Docs content moves out of README into `docs/`.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, pnpm workspace. Spec: `docs/superpowers/specs/2026-06-10-config-and-docs-split-design.md`.

**Conventions:** Run all package commands from `packages/runtime-plugin` unless noted. Build before using the CLI from the host (`pnpm --filter @federated-compute/machinen-plugin build`). Tests follow existing style in `packages/runtime-plugin/test/*.test.ts` (vitest, in-process guests via `createGuestRuntime`/`serveGuest` from `src/guest.ts`).

---

### Task 1: Config loader (`src/config.ts`)

**Files:**
- Create: `packages/runtime-plugin/src/config.ts`
- Modify: `packages/runtime-plugin/src/index.ts` (add export)
- Test: `packages/runtime-plugin/test/config.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/runtime-plugin/test/config.test.ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { findMachinenConfigPath, loadMachinenConfig } from '../src/config.js';

const tmpDirs: string[] = [];
function tmpdir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'machinen-config-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const VALID = JSON.stringify({
  machines: {
    compute_machine: { url: 'machinen+http://127.0.0.1:3801', version: '^1.0.0' },
    java_machine: { url: 'machinen+http://127.0.0.1:3802' },
  },
  bindgen: { outDir: 'src/machines' },
});

describe('findMachinenConfigPath', () => {
  test('finds machinen.config.json by walking up from a nested dir', () => {
    const root = tmpdir();
    writeFileSync(path.join(root, 'machinen.config.json'), VALID);
    const nested = path.join(root, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    expect(findMachinenConfigPath(nested)).toBe(path.join(root, 'machinen.config.json'));
  });

  test('returns undefined when no config exists anywhere up the tree', () => {
    expect(findMachinenConfigPath(tmpdir())).toBeUndefined();
  });
});

describe('loadMachinenConfig', () => {
  test('parses machines and bindgen.outDir, reporting path and dir', () => {
    const root = tmpdir();
    writeFileSync(path.join(root, 'machinen.config.json'), VALID);
    const config = loadMachinenConfig(root);
    expect(config?.path).toBe(path.join(root, 'machinen.config.json'));
    expect(config?.dir).toBe(root);
    expect(config?.machines.compute_machine).toEqual({
      url: 'machinen+http://127.0.0.1:3801',
      version: '^1.0.0',
    });
    expect(config?.machines.java_machine).toEqual({ url: 'machinen+http://127.0.0.1:3802' });
    expect(config?.bindgen.outDir).toBe('src/machines');
  });

  test('defaults bindgen.outDir to src/generated', () => {
    const root = tmpdir();
    writeFileSync(
      path.join(root, 'machinen.config.json'),
      JSON.stringify({ machines: { m: { url: 'machinen+http://h:1' } } }),
    );
    expect(loadMachinenConfig(root)?.bindgen.outDir).toBe('src/generated');
  });

  test('returns undefined when absent (callers decide if that is an error)', () => {
    expect(loadMachinenConfig(tmpdir())).toBeUndefined();
  });

  test('errors name the file and offending key', () => {
    const root = tmpdir();
    writeFileSync(
      path.join(root, 'machinen.config.json'),
      JSON.stringify({ machines: { broken: { url: 42 } } }),
    );
    expect(() => loadMachinenConfig(root)).toThrow(/machinen\.config\.json.*machines\.broken\.url/);
  });

  test('rejects invalid JSON with the file named', () => {
    const root = tmpdir();
    writeFileSync(path.join(root, 'machinen.config.json'), '{ nope');
    expect(() => loadMachinenConfig(root)).toThrow(/machinen\.config\.json.*invalid JSON/);
  });

  test('rejects a missing machines object', () => {
    const root = tmpdir();
    writeFileSync(path.join(root, 'machinen.config.json'), '{}');
    expect(() => loadMachinenConfig(root)).toThrow(/"machines" must be an object/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/config.test.ts` (in `packages/runtime-plugin`)
Expected: FAIL — `Cannot find module '../src/config.js'`

- [ ] **Step 3: Implement `src/config.ts`**

```ts
// packages/runtime-plugin/src/config.ts
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface MachinenConfigMachine {
  /** Machine entry, same forms the runtime accepts (machinen+http://..., machinen://...). */
  url: string;
  /** Semver range pinned onto the entry (MF requiredVersion analog). */
  version?: string;
}

export interface MachinenConfig {
  /** Absolute path of the resolved machinen.config.json. */
  path: string;
  /** Directory containing the config; bindgen.outDir resolves relative to it. */
  dir: string;
  machines: Record<string, MachinenConfigMachine>;
  bindgen: { outDir: string };
}

export const MACHINEN_CONFIG_FILENAME = 'machinen.config.json';

/** Nearest machinen.config.json, walking up from startDir (default cwd). */
export function findMachinenConfigPath(startDir: string = process.cwd()): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, MACHINEN_CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function fail(file: string, message: string): never {
  throw new Error(`[machinen] ${file}: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseMachinenConfig(
  raw: string,
  file: string,
): Pick<MachinenConfig, 'machines' | 'bindgen'> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    fail(file, `invalid JSON (${(error as Error).message})`);
  }
  if (!isPlainObject(json)) fail(file, 'must be a JSON object');

  if (!isPlainObject(json.machines)) {
    fail(file, '"machines" must be an object mapping machine names to { url, version? }');
  }
  const machines: Record<string, MachinenConfigMachine> = {};
  for (const [name, value] of Object.entries(json.machines)) {
    if (!isPlainObject(value)) fail(file, `machines.${name} must be an object`);
    const { url, version } = value;
    if (typeof url !== 'string' || url.length === 0) {
      fail(file, `machines.${name}.url must be a non-empty string`);
    }
    if (version !== undefined && typeof version !== 'string') {
      fail(file, `machines.${name}.version must be a string`);
    }
    machines[name] = version === undefined ? { url } : { url, version };
  }

  let outDir = 'src/generated';
  if (json.bindgen !== undefined) {
    if (!isPlainObject(json.bindgen)) fail(file, '"bindgen" must be an object');
    const candidate = json.bindgen.outDir;
    if (candidate !== undefined) {
      if (typeof candidate !== 'string' || candidate.length === 0) {
        fail(file, 'bindgen.outDir must be a non-empty string');
      }
      outDir = candidate;
    }
  }
  return { machines, bindgen: { outDir } };
}

/** Load the nearest config, or undefined when none exists. Throws on invalid content. */
export function loadMachinenConfig(startDir?: string): MachinenConfig | undefined {
  const file = findMachinenConfigPath(startDir);
  if (!file) return undefined;
  const parsed = parseMachinenConfig(readFileSync(file, 'utf8'), file);
  return { ...parsed, path: file, dir: path.dirname(file) };
}
```

Add to `packages/runtime-plugin/src/index.ts` (after the `./client.js` export block):

```ts
export {
  MACHINEN_CONFIG_FILENAME,
  findMachinenConfigPath,
  loadMachinenConfig,
  parseMachinenConfig,
  type MachinenConfig,
  type MachinenConfigMachine,
} from './config.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/config.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-plugin/src/config.ts packages/runtime-plugin/src/index.ts packages/runtime-plugin/test/config.test.ts
git commit -m "Add machinen.config.json loader with walk-up discovery and validation"
```

---

### Task 2: Runtime precedence — `createMachines()` reads the config

**Files:**
- Modify: `packages/runtime-plugin/src/client.ts` (options interface ~line 21-39, `resolveEntry` ~line 123-137, `warm` ~line 218-221)
- Test: `packages/runtime-plugin/test/client.test.ts` (append a describe block)

Precedence per machine: `options.remotes` > `MACHINEN_REMOTE_<NAME>` env > config `machines[name].url`. Version: `options.versions` > module pin (`opts.version`) > config `machines[name].version`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/runtime-plugin/test/client.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// (merge these into the file's existing imports; keep imports at top of file)

describe('createMachines + machinen.config.json', () => {
  const configDirs: string[] = [];
  function writeConfig(contents: object): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'machinen-client-config-'));
    configDirs.push(dir);
    writeFileSync(path.join(dir, 'machinen.config.json'), JSON.stringify(contents));
    return dir;
  }
  afterAll(() => {
    for (const dir of configDirs) rmSync(dir, { recursive: true, force: true });
  });

  test('resolves a machine address from the config file with zero remotes', async () => {
    const guest = createGuestRuntime({
      name: 'cfg_machine',
      version: '1.0.0',
      exposes: { './math': { add: { handler: (a: number, b: number) => a + b, returns: 'number' } } },
    });
    const server = await serveGuest(guest, { port: 0 });
    servers.push(server); // reuse the file's existing servers cleanup array
    const configDir = writeConfig({
      machines: { cfg_machine: { url: `machinen+http://127.0.0.1:${server.port}` } },
    });

    const machines = createMachines({ configDir });
    await expect(machines.machine('cfg_machine').math.add(20, 22)).resolves.toBe(42);
  });

  test('env var overrides the config file address', async () => {
    const guest = createGuestRuntime({
      name: 'env_machine',
      version: '1.0.0',
      exposes: { './math': { add: { handler: (a: number, b: number) => a + b, returns: 'number' } } },
    });
    const server = await serveGuest(guest, { port: 0 });
    servers.push(server);
    // Config points at a dead port; env points at the live guest.
    const configDir = writeConfig({
      machines: { env_machine: { url: 'machinen+http://127.0.0.1:9' } },
    });
    process.env.MACHINEN_REMOTE_ENV_MACHINE = `machinen+http://127.0.0.1:${server.port}`;
    try {
      const machines = createMachines({ configDir });
      await expect(machines.machine('env_machine').math.add(1, 2)).resolves.toBe(3);
    } finally {
      delete process.env.MACHINEN_REMOTE_ENV_MACHINE;
    }
  });

  test('config version pin is enforced (attach rejects incompatible machines)', async () => {
    const guest = createGuestRuntime({
      name: 'old_machine',
      version: '1.0.0',
      exposes: { './math': { add: { handler: (a: number, b: number) => a + b, returns: 'number' } } },
    });
    const server = await serveGuest(guest, { port: 0 });
    servers.push(server);
    const configDir = writeConfig({
      machines: {
        old_machine: { url: `machinen+http://127.0.0.1:${server.port}`, version: '^2.0.0' },
      },
    });

    const machines = createMachines({ configDir });
    await expect(machines.machine('old_machine').math.add(1, 1)).rejects.toThrow(/version/i);
  });

  test('missing-address error mentions options, env key, and the config file', () => {
    const configDir = writeConfig({ machines: {} });
    const machines = createMachines({ configDir });
    expect(() => machines.machine('ghost_machine').math.add(1, 1)).toThrow(
      /MACHINEN_REMOTE_GHOST_MACHINE.*machinen\.config\.json/s,
    );
  });
});
```

Note: reuse the existing test file's imports of `createMachines`, `createGuestRuntime`, `serveGuest`, and its `servers` cleanup array; only add what's missing. If the existing file tracks servers differently, follow its pattern.

- [ ] **Step 2: Run tests to verify the new block fails**

Run: `pnpm vitest run test/client.test.ts`
Expected: new tests FAIL (`configDir` not a known option / no address resolution from config); pre-existing tests PASS.

- [ ] **Step 3: Implement in `src/client.ts`**

Add the import at the top (imports stay at top of file):

```ts
import { loadMachinenConfig, type MachinenConfig } from './config.js';
```

Add to `MachinesOptions`:

```ts
  /**
   * Where to start searching for machinen.config.json (walks upward).
   * Default: process.cwd(). The config is the lowest-precedence source of
   * machine addresses and version pins: options > MACHINEN_REMOTE_* env > config.
   */
  configDir?: string;
```

Inside `createMachines`, before `resolveEntry`, add a memoized loader:

```ts
  let configLoaded = false;
  let machinenConfig: MachinenConfig | undefined;
  function configFile(): MachinenConfig | undefined {
    if (!configLoaded) {
      machinenConfig = loadMachinenConfig(options.configDir);
      configLoaded = true;
    }
    return machinenConfig;
  }
```

Replace the body of `resolveEntry` (currently lines 123-137):

```ts
  function resolveEntry(name: string, opts?: MachineModuleOptions): string {
    const fromConfig = configFile()?.machines[name];
    const base = options.remotes?.[name] ?? process.env[envKeyFor(name)] ?? fromConfig?.url;
    if (!base) {
      const searched = configFile()
        ? `add it to ${configFile()!.path}`
        : 'add a machinen.config.json (none found from the working directory upward)';
      throw new Error(
        `[machinen] no address for machine "${name}". Pass it in createMachines({ remotes }), ` +
          `set ${envKeyFor(name)} (e.g. machinen+http://127.0.0.1:3801), or ${searched}.`,
      );
    }
    const spec = parseMachineEntry(name, base);
    const token = options.token ?? process.env.MACHINEN_TOKEN;
    if (token && !spec.auth?.token) spec.auth = { token };
    // Priority: explicit ?version= on the entry > client options.versions
    // > module pin > config file pin.
    const version = options.versions?.[name] ?? opts?.version ?? fromConfig?.version;
    if (version && !spec.params.has('version')) spec.params.set('version', version);
    return formatMachineEntry(spec);
  }
```

Update `warm` so zero-arg warming covers config machines:

```ts
    async warm(remoteNames) {
      const names =
        remoteNames ?? Object.keys(options.remotes ?? configFile()?.machines ?? {});
      await plugin.warm(names.map((name) => ({ name, entry: ensureRegistered(name) })));
    },
```

- [ ] **Step 4: Run the full package test suite**

Run: `pnpm vitest run` (in `packages/runtime-plugin`)
Expected: PASS, including all pre-existing client/plugin/conformance tests.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-plugin/src/client.ts packages/runtime-plugin/test/client.test.ts
git commit -m "Resolve machine addresses and version pins from machinen.config.json in createMachines"
```

---

### Task 3: Barrel generation + manifest fetch helper (`src/bindgen.ts`)

**Files:**
- Modify: `packages/runtime-plugin/src/bindgen.ts`
- Modify: `packages/runtime-plugin/src/index.ts` (export new functions)
- Test: `packages/runtime-plugin/test/bindgen.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `packages/runtime-plugin/test/bindgen.test.ts`:

```ts
import { bindingExportNames, fetchMachineManifest, generateBarrel } from '../src/bindgen.js';
// (merge into existing imports at top of file)

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/bindgen.test.ts`
Expected: FAIL — `bindingExportNames`, `generateBarrel`, `fetchMachineManifest` not exported.

- [ ] **Step 3: Implement in `src/bindgen.ts`**

Add after the existing `identifier()` function:

```ts
/** Sorted, legal binding export names for a manifest's exposes (matches generateBindings). */
export function bindingExportNames(manifest: MachineExposeManifest): string[] {
  return Object.keys(manifest.exposes)
    .sort((a, b) => a.localeCompare(b))
    .map((p) => identifier(p));
}

/** Machine names from foreign manifests must still be legal `export * as` identifiers. */
function namespaceIdentifier(machineName: string): string {
  const id = machineName.replace(/[^a-zA-Z0-9_$]/g, '_');
  if (/^\d/.test(id)) return `_${id}`;
  return isJsReservedWord(id) ? `${id}_` : id;
}

/**
 * Barrel for a config-driven bindgen run: one namespace export per machine,
 * plus flat re-exports for binding names that are unambiguous across machines.
 */
export function generateBarrel(machines: { name: string; exportNames: string[] }[]): string {
  const sorted = [...machines].sort((a, b) => a.name.localeCompare(b.name));
  const counts = new Map<string, number>();
  for (const machine of sorted) {
    for (const exportName of machine.exportNames) {
      counts.set(exportName, (counts.get(exportName) ?? 0) + 1);
    }
  }
  const lines: string[] = [
    '// AUTO-GENERATED barrel by machinen bindgen. Do not edit by hand.',
    '// Names shared by several machines are only reachable through their namespace.',
  ];
  for (const machine of sorted) {
    lines.push(`export * as ${namespaceIdentifier(machine.name)} from './${machine.name}';`);
  }
  for (const machine of sorted) {
    const unique = machine.exportNames.filter((exportName) => counts.get(exportName) === 1);
    if (unique.length) lines.push(`export { ${unique.join(', ')} } from './${machine.name}';`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Fetch and validate a machine's protocol-3 manifest. */
export async function fetchMachineManifest(
  machineUrl: string,
  opts: { token?: string } = {},
): Promise<MachineExposeManifest> {
  const base = machineUrl.replace(/\/$/, '');
  const headers: Record<string, string> = opts.token
    ? { authorization: `Bearer ${opts.token}` }
    : {};
  const res = await fetch(`${base}/mf-manifest.json`, { headers });
  if (!res.ok) {
    throw new Error(`bindgen: manifest request failed with ${res.status} for ${machineUrl}`);
  }
  const manifest = (await res.json()) as MachineExposeManifest;
  if (manifest.protocol !== 3) {
    throw new Error(
      `bindgen: machine at ${machineUrl} speaks guest protocol ${String(manifest.protocol)}, expected 3`,
    );
  }
  return manifest;
}
```

Then refactor `fetchBindingsSource` to delegate (replace its manifest-fetching tail):

```ts
export async function fetchBindingsSource(
  machineUrl: string,
  opts: { token?: string } = {},
): Promise<string> {
  const base = machineUrl.replace(/\/$/, '');
  const headers: Record<string, string> = opts.token
    ? { authorization: `Bearer ${opts.token}` }
    : {};

  const published = await fetch(`${base}/mf-types.ts`, { headers });
  if (published.ok) return await published.text();

  return generateBindings(await fetchMachineManifest(machineUrl, opts));
}
```

Update the bindgen export line in `packages/runtime-plugin/src/index.ts`:

```ts
export {
  bindingExportNames,
  fetchBindingsSource,
  fetchMachineManifest,
  generateBarrel,
  generateBindings,
  isJsReservedWord,
} from './bindgen.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/bindgen.test.ts`
Expected: PASS (all pre-existing + new).

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-plugin/src/bindgen.ts packages/runtime-plugin/src/index.ts packages/runtime-plugin/test/bindgen.test.ts
git commit -m "Add barrel generation and manifest fetch helper for config-driven bindgen"
```

---

### Task 4: Config-driven bindgen orchestration (`src/bindgen-run.ts`)

**Files:**
- Create: `packages/runtime-plugin/src/bindgen-run.ts`
- Modify: `packages/runtime-plugin/src/index.ts` (export)
- Test: `packages/runtime-plugin/test/bindgen-run.test.ts`

Library function the CLI calls. Per machine: env override (`MACHINEN_REMOTE_<NAME>`) > config url; token precedence: explicit `token` arg > entry `?token=` > `MACHINEN_TOKEN`. No fail-fast: every machine reports a result. `check: true` does zero writes and reports drift.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/runtime-plugin/test/bindgen-run.test.ts
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/bindgen-run.test.ts`
Expected: FAIL — `Cannot find module '../src/bindgen-run.js'`

- [ ] **Step 3: Implement `src/bindgen-run.ts`**

```ts
// packages/runtime-plugin/src/bindgen-run.ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bindingExportNames, fetchMachineManifest, generateBarrel, generateBindings } from './bindgen.js';
import { envKeyFor } from './client.js';
import type { MachinenConfig } from './config.js';
import { parseMachineEntry } from './types.js';

export type BindgenFileStatus = 'written' | 'clean' | 'drift' | 'error';

export interface BindgenMachineResult {
  name: string;
  file: string;
  status: BindgenFileStatus;
  error?: string;
}

export interface BindgenRunResult {
  ok: boolean;
  outDir: string;
  machines: BindgenMachineResult[];
  /** The index.ts barrel result; absent when every machine errored. */
  barrel?: BindgenMachineResult;
}

export interface BindgenRunOptions {
  /** Diff against disk instead of writing; any difference or error fails the run. */
  check?: boolean;
  /** Overrides per-entry ?token= and the MACHINEN_TOKEN env var. */
  token?: string;
}

async function reconcile(
  file: string,
  source: string,
  check: boolean,
): Promise<Exclude<BindgenFileStatus, 'error'>> {
  if (!check) {
    await writeFile(file, source);
    return 'written';
  }
  const existing = await readFile(file, 'utf8').catch(() => undefined);
  return existing === source ? 'clean' : 'drift';
}

export async function runBindgenFromConfig(
  config: MachinenConfig,
  options: BindgenRunOptions,
): Promise<BindgenRunResult> {
  const check = options.check ?? false;
  const outDir = path.resolve(config.dir, config.bindgen.outDir);
  if (!check) await mkdir(outDir, { recursive: true });

  const generated = await Promise.all(
    Object.entries(config.machines).map(async ([name, machine]) => {
      const file = path.join(outDir, `${name}.ts`);
      try {
        const entry = process.env[envKeyFor(name)] ?? machine.url;
        const spec = parseMachineEntry(name, entry);
        const token = options.token ?? spec.auth?.token ?? process.env.MACHINEN_TOKEN;
        const manifest = await fetchMachineManifest(spec.url, { token });
        return { name, file, source: generateBindings(manifest), exportNames: bindingExportNames(manifest) };
      } catch (error) {
        return { name, file, error: (error as Error).message };
      }
    }),
  );

  const machines: BindgenMachineResult[] = [];
  const barrelInput: { name: string; exportNames: string[] }[] = [];
  for (const item of generated) {
    if ('error' in item) {
      machines.push({ name: item.name, file: item.file, status: 'error', error: item.error });
      continue;
    }
    machines.push({ name: item.name, file: item.file, status: await reconcile(item.file, item.source, check) });
    barrelInput.push({ name: item.name, exportNames: item.exportNames });
  }

  let barrel: BindgenMachineResult | undefined;
  if (barrelInput.length) {
    const file = path.join(outDir, 'index.ts');
    barrel = { name: 'index', file, status: await reconcile(file, generateBarrel(barrelInput), check) };
  }

  const all = barrel ? [...machines, barrel] : machines;
  const ok = all.every((m) => m.status === 'written' || m.status === 'clean');
  return { ok, outDir, machines, barrel };
}
```

Note on the barrel in partial-failure runs: when some machines error, the barrel is still produced from the successful ones in write mode; in check mode that naturally reports drift if the barrel previously covered more machines — and `ok` is already false because of the errors.

Add to `packages/runtime-plugin/src/index.ts`:

```ts
export {
  runBindgenFromConfig,
  type BindgenMachineResult,
  type BindgenRunOptions,
  type BindgenRunResult,
} from './bindgen-run.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/bindgen-run.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-plugin/src/bindgen-run.ts packages/runtime-plugin/src/index.ts packages/runtime-plugin/test/bindgen-run.test.ts
git commit -m "Add config-driven bindgen runner with barrel output and check mode"
```

---

### Task 5: CLI — no-arg config mode + `--check` (`src/cli.ts`)

**Files:**
- Modify: `packages/runtime-plugin/src/cli.ts` (full rewrite, it's 41 lines)

No unit tests for the shell itself — all logic is already covered by Task 4; verification is a build + smoke run.

- [ ] **Step 1: Rewrite `src/cli.ts`**

```ts
#!/usr/bin/env node
/**
 * machinen-bindgen — the machine analog of Module Federation's DTS flow.
 *
 * Config mode (default): finds machinen.config.json (walking up from cwd),
 * regenerates one binding file per machine plus an index.ts barrel:
 *
 *   machinen-bindgen
 *   machinen-bindgen --check    # diff against disk, exit 1 on drift; writes nothing
 *
 * Single-machine mode (ad hoc):
 *
 *   machinen-bindgen --url http://127.0.0.1:3801 --out src/generated/compute_machine.ts
 *
 * Auth: --token, per-entry ?token=, or the MACHINEN_TOKEN env var.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runBindgenFromConfig } from './bindgen-run.js';
import { fetchBindingsSource } from './bindgen.js';
import { MACHINEN_CONFIG_FILENAME, loadMachinenConfig } from './config.js';

interface CliArgs {
  url?: string;
  out?: string;
  token?: string;
  check: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { check: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--check') {
      args.check = true;
    } else if (key === '--url' || key === '--out' || key === '--token') {
      const value = argv[++i];
      if (value === undefined) usage();
      args[key.slice(2) as 'url' | 'out' | 'token'] = value;
    } else {
      usage();
    }
  }
  return args;
}

function usage(): never {
  console.error(
    'usage: machinen-bindgen [--check] [--token <token>]\n' +
      '       machinen-bindgen --url <machine-url> --out <file.ts> [--token <token>]',
  );
  process.exit(2);
}

async function runSingle(url: string, out: string, token?: string): Promise<void> {
  const source = await fetchBindingsSource(url, { token: token ?? process.env.MACHINEN_TOKEN });
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, source);
  console.log(`machinen-bindgen: ${url} -> ${out}`);
}

async function runConfig(check: boolean, token?: string): Promise<void> {
  const config = loadMachinenConfig();
  if (!config) {
    console.error(
      `machinen-bindgen: no ${MACHINEN_CONFIG_FILENAME} found from ${process.cwd()} upward. ` +
        'Create one, or use --url/--out for single-machine mode.',
    );
    process.exit(2);
  }
  const result = await runBindgenFromConfig(config, { check, token });
  const all = result.barrel ? [...result.machines, result.barrel] : result.machines;
  for (const m of all) {
    const rel = path.relative(process.cwd(), m.file);
    if (m.status === 'error') console.error(`machinen-bindgen: ${m.name}: ERROR ${m.error}`);
    else console.log(`machinen-bindgen: ${m.status.padEnd(7)} ${rel}`);
  }
  if (!result.ok) {
    if (check) console.error('machinen-bindgen: bindings drifted or failed — run `machinen-bindgen` to regenerate');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const { url, out, token, check } = parseArgs(process.argv.slice(2));
  if (url || out) {
    if (!url || !out || check) usage();
    await runSingle(url, out, token);
    return;
  }
  await runConfig(check, token);
}

main().catch((error) => {
  console.error('machinen-bindgen:', error);
  process.exit(1);
});
```

- [ ] **Step 2: Build and verify the package**

Run: `pnpm --filter @federated-compute/machinen-plugin build && pnpm --filter @federated-compute/machinen-plugin test`
Expected: build clean, all tests PASS.

- [ ] **Step 3: Smoke-check usage output**

Run: `node packages/runtime-plugin/dist/cli.js --bogus`
Expected: usage text printed, exit code 2.
Run (from a dir with no config, e.g. `/tmp`): `node <repo>/packages/runtime-plugin/dist/cli.js`
Expected: "no machinen.config.json found" error, exit code 2.

- [ ] **Step 4: Commit**

```bash
git add packages/runtime-plugin/src/cli.ts
git commit -m "Teach machinen-bindgen a no-arg config mode with --check drift detection"
```

---

### Task 6: Host adoption — config file, barrel imports, drop the wrapper

**Files:**
- Create: `apps/host/machinen.config.json`
- Delete: `apps/host/bindgen.mjs`
- Modify: `apps/host/package.json` (bindgen script)
- Modify: `apps/host/src/index.ts` (imports, lines 5-7)
- Modify: `apps/host/src/server.ts` (imports, lines 8-12; counter call sites)
- Modify: `scripts/bindgen.mjs` (forward CLI args)
- Generated: `apps/host/src/generated/*.ts` + new `index.ts` (via bindgen)

- [ ] **Step 1: Create `apps/host/machinen.config.json`**

URLs are the dev defaults currently hardcoded in `apps/host/bindgen.mjs`; env vars still override at runtime and in bindgen.

```json
{
  "machines": {
    "compute_machine": { "url": "machinen+http://127.0.0.1:3801", "version": "^1.0.0" },
    "java_machine": { "url": "machinen+http://127.0.0.1:3802", "version": "^1.0.0" },
    "python_machine": { "url": "machinen+http://127.0.0.1:3803", "version": "^1.0.0" },
    "db_machine": { "url": "machinen+http://127.0.0.1:3804", "version": "^1.0.0" },
    "analytics_machine": { "url": "machinen+http://127.0.0.1:3805", "version": "^1.0.0" }
  },
  "bindgen": { "outDir": "src/generated" }
}
```

- [ ] **Step 2: Swap the host bindgen script and delete the wrapper**

In `apps/host/package.json`, change the script (the `machinen-bindgen` bin resolves from the workspace dependency):

```json
    "bindgen": "machinen-bindgen"
```

Delete `apps/host/bindgen.mjs`.

- [ ] **Step 3: Forward args in `scripts/bindgen.mjs`**

The orchestrator boots machines, then runs the host's bindgen; it must forward `--check`. Change the spawn line:

```js
    const child = spawn('pnpm', ['--filter', 'host', 'bindgen', ...process.argv.slice(2)], {
```

(Everything else in the file stays as-is; `remoteEnv()` already injects `MACHINEN_REMOTE_*`, which the CLI's config mode honors as overrides.)

- [ ] **Step 4: Regenerate bindings through the new path**

Run (repo root): `pnpm --filter @federated-compute/machinen-plugin build && pnpm bindgen`
Expected: per-file `written` lines for all five machines plus `src/generated/index.ts`; exit 0.

Run: `pnpm bindgen --check`
Expected: all `clean`, exit 0.

- [ ] **Step 5: Switch host imports to the barrel**

`apps/host/src/index.ts` lines 5-7 become:

```ts
import { math, text, strings, compute, stats, data } from './generated';
```

`apps/host/src/server.ts` lines 8-12 become (counters collide across machines, so they come through namespaces):

```ts
import {
  math,
  text,
  strings,
  stats,
  data,
  db,
  analytics,
  compute_machine,
  java_machine,
  python_machine,
} from './generated';

const nodeCounter = compute_machine.counter;
const javaCounter = java_machine.counter;
const pyCounter = python_machine.counter;
```

No other call sites change (the aliases keep their names).

Check for any other generated imports: `rg -n "from './generated/" apps/host/src` — update any stragglers the same way (flat name if unique, namespace if shared).

- [ ] **Step 6: Verify the host builds and the demos pass**

Run: `pnpm -r build && node scripts/demo.mjs && node scripts/demo-web.mjs --smoke`
Expected: build clean; demo prints its results; web smoke passes.

- [ ] **Step 7: Commit**

```bash
git add apps/host/machinen.config.json apps/host/package.json apps/host/src scripts/bindgen.mjs
git rm apps/host/bindgen.mjs
git commit -m "Drive host bindgen and imports from machinen.config.json with a generated barrel"
```

---

### Task 7: CI drift check

**Files:**
- Modify: `.github/workflows/ci.yml` (after the "Build all packages" step, line 37)

- [ ] **Step 1: Add the step**

```yaml
      - name: Bindgen drift check (generated bindings match deployed manifests)
        run: node scripts/bindgen.mjs --check
```

Place it between "Build all packages" and "End-to-end demo".

- [ ] **Step 2: Verify locally**

Run: `node scripts/bindgen.mjs --check`
Expected: machines boot, all files report `clean`, exit 0.
Then sanity-check failure: append a comment line to `apps/host/src/generated/compute_machine.ts`, run again, expect `drift` + exit 1, then `git checkout -- apps/host/src/generated`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "Fail CI when generated machine bindings drift from deployed manifests"
```

---

### Task 8: Docs split

**Files:**
- Modify: `README.md` (rewrite to ~80 lines)
- Create: `docs/operators.md`
- Create: `docs/machinen-driver.md`
- Create: `docs/writing-a-machine.md`
- Unchanged: `docs/guest-protocol.md`

Use the pre-split README from git history as the source of truth when moving content: `git show HEAD:README.md`. Line references below are to the current README. Move content with light editing only (fix transitions, update cross-links); do not drop technical content.

- [ ] **Step 1: Create `docs/operators.md`**

Move these README sections, in order, under a `# Operators guide` title:
- "For operators and advanced wiring" (lines 34-67)
- "How it follows Module Federation" (lines 69-79)
- "How it works" (lines 81-117)
- "Custom runtime hooks" (lines 119-137)
- "Boot once, run everywhere" (lines 139-162)
- "Interactive demo" (lines 163-172) and "Data gravity" (lines 174-192)

Add a short intro paragraph: this doc covers wiring, call policy, hooks, metrics, drivers, and the demos; end users only need the README. Add a section documenting `machinen.config.json` (schema from the spec, the precedence rule options > `MACHINEN_REMOTE_*` env > config, and `machinen-bindgen` / `--check` usage).

- [ ] **Step 2: Create `docs/machinen-driver.md`**

Move under a `# Real Machinen driver` title:
- "Real Machinen driver" (lines 280-365)
- "Real Machinen validation in CI" (lines 367-392)

Keep the perf table, security note, and all five upstream-quirk entries verbatim.

- [ ] **Step 3: Create `docs/writing-a-machine.md`**

New content, `# Writing a machine`, covering:
- What a machine is (one paragraph; protocol summary: `GET /mf-manifest.json`, `GET /mf/health`, `POST /mf/call`, bearer auth, NDJSON streaming) with a link to `docs/guest-protocol.md` for the full wire contract.
- Node path: use `createGuestRuntime` + `serveGuest` from `@federated-compute/machinen-plugin/guest`; show a complete minimal guest (name, version, one exposed module with a unary and a streaming function) modeled on `apps/remote`.
- Java path: point at `apps/remote-java` (`src/dev/machinen/*`, zero deps, builds `dist/java-machine.jar`) as the reference; note the manifest carries full signatures so no TS toolchain is needed.
- Python path: point at `apps/remote-python` (`machinen_guest` package, stdlib only) as the reference.
- Types: serve `GET /mf-types.ts` if you can generate it; otherwise the manifest's signatures are enough — hosts render bindings from it.
- Conformance: how to validate a guest with the conformance suite (`packages/runtime-plugin/test/conformance.test.ts` exercises all three reference guests; follow its pattern, or run `pnpm test` with your machine's address exported).
- Optional `state` capability (`GET/POST /mf/state`) for app-state snapshots.

- [ ] **Step 4: Rewrite `README.md` (~80 lines)**

Keep, in order:
1. Title + the two intro paragraphs (lines 1-14).
2. "For end users: it's just imports" (lines 16-32), with the import path updated to the barrel: `import { strings, math } from './generated';` and one added sentence: machine addresses live in `machinen.config.json` (link to the operators doc section), overridable per environment with `MACHINEN_REMOTE_<NAME>`.
3. A trimmed "What is this for?" — keep the intro paragraph and the six bold lead sentences (one line each), dropping the supporting paragraphs (they move nowhere; the bold sentences carry the pitch — full version remains in git history; if that feels too lossy, move the full section to `docs/operators.md` instead and link it).
4. "Layout" table (lines 248-260), updated: add `apps/host/machinen.config.json` mention and `docs/operators.md`, `docs/machinen-driver.md`, `docs/writing-a-machine.md` rows.
5. "Run it" (lines 262-278) unchanged, plus `pnpm bindgen --check` in the command list.
6. A short "Docs" section linking the four docs files.
7. The "Status" paragraph (lines 394-404), with its driver details replaced by a link to `docs/machinen-driver.md`.

- [ ] **Step 5: Verify links and length**

Run: `wc -l README.md` — expect roughly 80-110 lines.
Run: `rg -o "\\]\\((docs/[^)]+)\\)" -r '$1' README.md docs/*.md | sort -u` and confirm each referenced file exists. Also `rg -n "guest-protocol" docs/writing-a-machine.md` to confirm the protocol link.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/operators.md docs/machinen-driver.md docs/writing-a-machine.md
git commit -m "Split README into quickstart plus operators, driver, and machine-authoring docs"
```

---

### Task 9: Final verification

- [ ] **Step 1: Full suite**

Run (repo root): `pnpm test && pnpm -r build`
Expected: all unit + conformance tests pass; all builds clean.

- [ ] **Step 2: Demos**

Run: `node scripts/demo.mjs && node scripts/demo-snapshot.mjs && node scripts/demo-gravity.mjs && node scripts/demo-web.mjs --smoke`
Expected: all pass (CI parity).

- [ ] **Step 3: Bindgen round-trip**

Run: `pnpm bindgen && git status --short apps/host/src/generated && pnpm bindgen --check`
Expected: regeneration produces no git diff; check exits 0.
