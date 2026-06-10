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
