import type { FunctionSignature, MachineExposeManifest } from './types.js';

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

/**
 * Bindgen: turn a machine's typed manifest into TypeScript interfaces, so the
 * consumer's `loadRemote<T>` types come from the machine itself instead of
 * being hand-written.
 */
export function generateBindings(manifest: MachineExposeManifest): string {
  const machineName = pascalCase(manifest.name);
  const lines: string[] = [
    `// AUTO-GENERATED from the "${manifest.name}" machine manifest by machinen bindgen.`,
    '// Do not edit by hand — regenerate with `pnpm bindgen`.',
    '',
  ];

  const moduleMap: string[] = [];
  for (const [exposePath, fns] of Object.entries(manifest.exposes)) {
    const interfaceName = machineName + pascalCase(exposePath);
    lines.push(`export interface ${interfaceName} {`);
    for (const [fn, sig] of Object.entries(fns)) {
      lines.push(renderFunction(fn, sig));
    }
    lines.push('}', '');
    moduleMap.push(`  '${exposePath}': ${interfaceName};`);
  }

  lines.push(`export interface ${machineName}Modules {`, ...moduleMap, '}', '');
  return lines.join('\n');
}
