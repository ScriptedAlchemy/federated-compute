import { describe, expect, test } from 'vitest';
import { generateBindings } from '../src/bindgen.js';
import type { MachineExposeManifest } from '../src/types.js';

const manifest: MachineExposeManifest = {
  name: 'java_machine',
  protocol: 3,
  version: '1.0.0',
  exposes: {
    './strings': {
      upper: { params: [{ name: 's', type: 'string' }], returns: 'string' },
      sha256: { params: [{ name: 's', type: 'string' }], returns: 'string' },
    },
    './compute': {
      primesBelow: { params: [{ name: 'n', type: 'number' }], returns: 'number[]' },
      countdown: {
        params: [{ name: 'from', type: 'number' }],
        returns: 'number',
        stream: true,
      },
    },
  },
};

describe('generateBindings', () => {
  test('emits one interface per exposed module plus a module map', () => {
    const src = generateBindings(manifest);

    expect(src).toContain('export interface JavaMachineStrings {');
    expect(src).toContain('upper(s: string): Promise<string>;');
    expect(src).toContain('sha256(s: string): Promise<string>;');
    expect(src).toContain('export interface JavaMachineCompute {');
    expect(src).toContain('primesBelow(n: number): Promise<number[]>;');
    // Streaming functions return async iterables, not promises.
    expect(src).toContain('countdown(from: number): AsyncIterable<number>;');
    expect(src).toContain("'./strings': JavaMachineStrings;");
    expect(src).toContain("'./compute': JavaMachineCompute;");
    expect(src).toContain('export interface JavaMachineModules {');
  });
});
