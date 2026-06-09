import { stripExposePrefix, type FunctionSignature, type MachineExposeManifest } from './types.js';

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
  return stripExposePrefix(exposePath).replace(/[^a-zA-Z0-9_$]/g, '_');
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
  for (const [exposePath, fns] of Object.entries(manifest.exposes)) {
    const interfaceName = machineName + pascalCase(exposePath);
    lines.push(`export interface ${interfaceName} {`);
    for (const [fn, sig] of Object.entries(fns)) {
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
