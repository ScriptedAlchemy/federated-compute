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
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runBindgenFromConfig } from './bindgen-run.js';
import { fetchBindingsSource } from './bindgen.js';
import { MACHINEN_CONFIG_FILENAME, loadMachinenConfig } from './config.js';

interface CliArgs {
  url?: string;
  out?: string;
  check: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { check: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--check') {
      args.check = true;
    } else if (key === '--url' || key === '--out') {
      const value = argv[++i];
      if (value === undefined) usage();
      args[key.slice(2) as 'url' | 'out'] = value;
    } else {
      usage();
    }
  }
  return args;
}

function usage(): never {
  console.error(
    'usage: machinen-bindgen [--check]\n' +
      '       machinen-bindgen --url <machine-url> --out <file.ts>',
  );
  process.exit(2);
}

async function runSingle(url: string, out: string): Promise<void> {
  const source = await fetchBindingsSource(url);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, source);
  console.log(`machinen-bindgen: ${url} -> ${out}`);
}

async function runConfig(check: boolean): Promise<void> {
  const config = loadMachinenConfig();
  if (!config) {
    console.error(
      `machinen-bindgen: no ${MACHINEN_CONFIG_FILENAME} found from ${process.cwd()} upward. ` +
        'Create one, or use --url/--out for single-machine mode.',
    );
    process.exit(2);
  }
  const result = await runBindgenFromConfig(config, { check });
  const all = result.barrel ? [...result.machines, result.barrel] : result.machines;
  for (const m of all) {
    const rel = path.relative(process.cwd(), m.file);
    if (m.status === 'error') console.error(`machinen-bindgen: ${m.name}: ERROR ${m.error}`);
    else console.log(`machinen-bindgen: ${m.status.padEnd(7)} ${rel}`);
  }
  for (const file of result.pruned) {
    const rel = path.relative(process.cwd(), file);
    console.log(`machinen-bindgen: ${(check ? 'stale' : 'pruned').padEnd(7)} ${rel}`);
  }
  if (!result.ok) {
    if (check) console.error('machinen-bindgen: bindings drifted or failed — run `machinen-bindgen` to regenerate');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const { url, out, check } = parseArgs(process.argv.slice(2));
  if (url || out) {
    if (!url || !out || check) usage();
    await runSingle(url, out);
    return;
  }
  await runConfig(check);
}

main().catch((error) => {
  console.error('machinen-bindgen:', error);
  process.exit(1);
});
