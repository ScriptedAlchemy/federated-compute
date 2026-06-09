#!/usr/bin/env node
/**
 * machinen-bindgen: fetch a deployed machine's typed manifest and emit
 * TypeScript interfaces — the machine analog of Module Federation's DTS flow.
 *
 *   machinen-bindgen --url http://127.0.0.1:3801 --out src/generated/compute_machine.ts
 *
 * Auth: --token or the MACHINEN_TOKEN env var.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchBindingsSource } from './bindgen.js';

function parseArgs(argv: string[]): { url?: string; out?: string; token?: string } {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith('--') || argv[i + 1] === undefined) break;
    args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

async function main() {
  const { url, out, token = process.env.MACHINEN_TOKEN } = parseArgs(process.argv.slice(2));
  if (!url || !out) {
    console.error('usage: machinen-bindgen --url <machine-url> --out <file.ts> [--token <token>]');
    process.exit(2);
  }

  const source = await fetchBindingsSource(url, { token });
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, source);
  console.log(`machinen-bindgen: ${url} -> ${out}`);
}

main().catch((error) => {
  console.error('machinen-bindgen:', error);
  process.exit(1);
});
