import { stripExposePrefix, type FunctionSignature, type MachineExposeManifest } from './types.js';

// Reserved words (incl. strict-mode and future-reserved) are syntactically
// valid per the identifier regexes but cannot be export/binding names.
const JS_RESERVED_WORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'implements', 'import', 'in',
  'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private',
  'protected', 'public', 'return', 'static', 'super', 'switch', 'this',
  'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);

export function isJsReservedWord(word: string): boolean {
  return JS_RESERVED_WORDS.has(word);
}

function pascalCase(input: string): string {
  return input
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');
}

function renderFunction(name: string, sig: FunctionSignature): string {
  const params = sig.params.map((p) => `${p.name}: ${p.type}`).join(', ');
  const returns = sig.stream ? `AsyncIterable<${sig.returns}>` : `Promise<${sig.returns}>`;
  return `  ${name}(${params}): ${returns};`;
}

function identifier(exposePath: string): string {
  const id = stripExposePrefix(exposePath).replace(/[^a-zA-Z0-9_$]/g, '_');
  // Foreign manifests may not have gone through guest-side validation, so a
  // reserved word ('./delete' -> delete) must still emit a legal export name.
  return isJsReservedWord(id) ? `${id}_` : id;
}

/**
 * Bindgen: turn a machine's typed manifest into ready-to-import TypeScript.
 * Emits interfaces (typing) plus lazy module bindings, so end-user code is:
 *
 *   import { strings } from './machines/java_machine';
 *   await strings.upper('hi');   // a call into the machine
 */
export function generateBindings(manifest: MachineExposeManifest): string {
  const machineName = pascalCase(manifest.name);
  const major = manifest.version?.split('.')[0] ?? '0';
  const versionRange = `^${major}.0.0`;
  const lines: string[] = [
    `// AUTO-GENERATED from the "${manifest.name}" machine manifest by machinen bindgen.`,
    '// Do not edit by hand — regenerate with `pnpm bindgen`.',
    "import { machineModule } from '@federated-compute/machinen-plugin/client';",
    '',
  ];

  const moduleMap: string[] = [];
  const bindings: string[] = [];
  // Sorted for determinism: guest languages don't all preserve map order.
  const sortedExposes = Object.entries(manifest.exposes).sort(([a], [b]) => a.localeCompare(b));
  for (const [exposePath, fns] of sortedExposes) {
    const interfaceName = machineName + pascalCase(exposePath);
    lines.push(`export interface ${interfaceName} {`);
    for (const [fn, sig] of Object.entries(fns).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(renderFunction(fn, sig));
    }
    lines.push('}', '');
    moduleMap.push(`  '${exposePath}': ${interfaceName};`);
    const streamFns = Object.entries(fns)
      .filter(([, sig]) => sig.stream)
      .map(([fn]) => `'${fn}'`);
    const streamsOpt = streamFns.length ? `, streams: [${streamFns.join(', ')}]` : '';
    bindings.push(
      `export const ${identifier(exposePath)} = machineModule<${interfaceName}>('${manifest.name}', '${exposePath}', { version: '${versionRange}'${streamsOpt} });`,
    );
  }

  lines.push(`export interface ${machineName}Modules {`, ...moduleMap, '}', '');
  lines.push(...bindings, '');
  return lines.join('\n');
}

/**
 * Host-side type distribution, MF-style: a machine publishes its own types
 * next to its manifest. Prefer the machine's `/mf-types.ts` artifact; fall
 * back to rendering from its manifest (which carries full signatures) when
 * the machine doesn't serve one. Network only — the host never reads another
 * repo's disk.
 */
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
  return generateBindings(manifest);
}
