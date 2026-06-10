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
    // The barrel is written as <outDir>/index.ts; a machine named "index"
    // would be overwritten by it and make the barrel import itself.
    if (name === 'index') {
      fail(file, 'machines.index: "index" is reserved for the generated barrel');
    }
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
