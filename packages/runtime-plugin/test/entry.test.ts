import { describe, expect, test } from 'vitest';
import { formatMachineEntry, isMachineEntry, parseMachineEntry } from '../src/types.js';

describe('machine entries', () => {
  test('recognizes image and attach entries', () => {
    expect(isMachineEntry('machinen://images/math.tar.gz')).toBe(true);
    expect(isMachineEntry('machinen+http://127.0.0.1:3801')).toBe(true);
    expect(isMachineEntry('https://cdn.example.com/remoteEntry.js')).toBe(false);
  });

  test('parses image entries with params', () => {
    const spec = parseMachineEntry('m', 'machinen://images/math.tar.gz?cpus=2&port=4000');
    expect(spec.kind).toBe('image');
    expect(spec.image).toBe('images/math.tar.gz');
    expect(spec.params.get('cpus')).toBe('2');
    expect(spec.params.get('port')).toBe('4000');
  });

  test('parses attach entries into a base url + params', () => {
    const spec = parseMachineEntry('m', 'machinen+http://127.0.0.1:3802?cpus=2');
    expect(spec.kind).toBe('attach');
    expect(spec.url).toBe('http://127.0.0.1:3802');
    expect(spec.params.get('cpus')).toBe('2');
  });

  test('attach entries keep any path component', () => {
    const spec = parseMachineEntry('m', 'machinen+https://machines.example.com/math');
    expect(spec.kind).toBe('attach');
    expect(spec.url).toBe('https://machines.example.com/math');
  });

  test('formatMachineEntry round-trips a parsed spec deterministically', () => {
    const spec = parseMachineEntry('m', 'machinen://images/m.img?cpus=1');
    expect(formatMachineEntry(spec)).toBe('machinen://images/m.img?cpus=1');
  });

  test('rejects non-machine entries', () => {
    expect(() => parseMachineEntry('m', 'https://cdn.example.com/x.js')).toThrow(
      /not a machine entry/,
    );
  });
});
