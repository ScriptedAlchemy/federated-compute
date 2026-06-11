import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  bindingExportNames,
  fetchBindingsSource,
  fetchMachineManifest,
  generateBarrel,
} from './bindgen.js';
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
  /** Stale auto-generated .ts files pruned in write mode, or dirty in check mode. */
  pruned: string[];
}

export interface BindgenRunOptions {
  /** Diff against disk instead of writing; any difference or error fails the run. */
  check?: boolean;
}

interface GeneratedMachine {
  name: string;
  file: string;
  source: string;
  exportNames: string[];
}

interface FailedMachine {
  name: string;
  file: string;
  error: string;
}

const AUTO_GENERATED_MARKER = 'AUTO-GENERATED';

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

async function findStaleGeneratedFiles(outDir: string, keep: Set<string>): Promise<string[]> {
  const entries = await readdir(outDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const stale: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const file = path.join(outDir, entry.name);
    if (keep.has(file)) continue;
    const source = await readFile(file, 'utf8');
    if (source.includes(AUTO_GENERATED_MARKER)) stale.push(file);
  }
  return stale.sort((a, b) => a.localeCompare(b));
}

async function reconcileStaleGeneratedFiles(
  outDir: string,
  keep: Set<string>,
  check: boolean,
): Promise<string[]> {
  const stale = await findStaleGeneratedFiles(outDir, keep);
  if (!check) {
    await Promise.all(stale.map((file) => rm(file, { force: true })));
  }
  return stale;
}

/**
 * Regenerate bindings for every machine in a config (plus the index.ts
 * barrel). No fail-fast: each machine reports its own result. With
 * `check: true` nothing is written; any drift or error makes `ok` false.
 */
export async function runBindgenFromConfig(
  config: MachinenConfig,
  options: BindgenRunOptions,
): Promise<BindgenRunResult> {
  const check = options.check ?? false;
  const outDir = path.resolve(config.dir, config.bindgen.outDir);
  if (!check) await mkdir(outDir, { recursive: true });

  const generated = await Promise.all(
    Object.entries(config.machines).map(
      async ([name, machine]): Promise<GeneratedMachine | FailedMachine> => {
        const file = path.join(outDir, `${name}.ts`);
        try {
          const entry = process.env[envKeyFor(name)] ?? machine.url;
          const spec = parseMachineEntry(name, entry);
          if (!spec.url) {
            throw new Error(`bindgen: entry for "${name}" is not an attachable machine URL`);
          }
          // Same type-distribution path as single-machine mode: prefer the
          // machine's published /mf-types.ts artifact, fall back to rendering
          // from the manifest. The manifest is still fetched for barrel
          // export names, which must reflect the actual exposed signatures.
          const [source, manifest] = await Promise.all([
            fetchBindingsSource(spec.url),
            fetchMachineManifest(spec.url),
          ]);
          return { name, file, source, exportNames: bindingExportNames(manifest) };
        } catch (error) {
          return { name, file, error: (error as Error).message };
        }
      },
    ),
  );

  const machines: BindgenMachineResult[] = [];
  const barrelInput: { name: string; exportNames: string[] }[] = [];
  const keep = new Set<string>();
  for (const item of generated) {
    if ('error' in item) {
      machines.push({ name: item.name, file: item.file, status: 'error', error: item.error });
      continue;
    }
    keep.add(item.file);
    machines.push({
      name: item.name,
      file: item.file,
      status: await reconcile(item.file, item.source, check),
    });
    barrelInput.push({ name: item.name, exportNames: item.exportNames });
  }

  // Intentional: in write mode the barrel is still produced from whichever
  // machines succeeded; in check mode `ok` is already false due to the errors.
  let barrel: BindgenMachineResult | undefined;
  if (barrelInput.length) {
    const file = path.join(outDir, 'index.ts');
    keep.add(file);
    barrel = { name: 'index', file, status: await reconcile(file, generateBarrel(barrelInput), check) };
  }

  const pruned = await reconcileStaleGeneratedFiles(outDir, keep, check);
  const all = barrel ? [...machines, barrel] : machines;
  const ok =
    all.every((m) => m.status === 'written' || m.status === 'clean') &&
    (!check || pruned.length === 0);
  return { ok, outDir, machines, barrel, pruned };
}
