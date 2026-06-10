import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  bindingExportNames,
  fetchMachineManifest,
  generateBarrel,
  generateBindings,
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
          const manifest = await fetchMachineManifest(spec.url);
          return {
            name,
            file,
            source: generateBindings(manifest),
            exportNames: bindingExportNames(manifest),
          };
        } catch (error) {
          return { name, file, error: (error as Error).message };
        }
      },
    ),
  );

  const machines: BindgenMachineResult[] = [];
  const barrelInput: { name: string; exportNames: string[] }[] = [];
  for (const item of generated) {
    if ('error' in item) {
      machines.push({ name: item.name, file: item.file, status: 'error', error: item.error });
      continue;
    }
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
    barrel = { name: 'index', file, status: await reconcile(file, generateBarrel(barrelInput), check) };
  }

  const all = barrel ? [...machines, barrel] : machines;
  const ok = all.every((m) => m.status === 'written' || m.status === 'clean');
  return { ok, outDir, machines, barrel };
}
