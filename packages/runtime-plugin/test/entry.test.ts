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

describe('pull entries (machinen+pull+http(s)://)', () => {
  test('recognizes pull entries', () => {
    expect(isMachineEntry('machinen+pull+http://127.0.0.1:3802')).toBe(true);
    expect(isMachineEntry('machinen+pull+https://registry.example/java_machine')).toBe(true);
  });

  test('parses a pull entry into kind, base url, and params', () => {
    const spec = parseMachineEntry(
      'java_machine',
      'machinen+pull+http://127.0.0.1:3802?artifact=snapshot&version=^1.0.0',
    );
    expect(spec.kind).toBe('pull');
    expect(spec.url).toBe('http://127.0.0.1:3802');
    expect(spec.image).toBeUndefined();
    expect(spec.params.get('artifact')).toBe('snapshot');
    expect(spec.params.get('version')).toBe('^1.0.0');
  });

  test('pull entries keep any path component (registry layout)', () => {
    const spec = parseMachineEntry('m', 'machinen+pull+https://registry.example/machines/java_machine');
    expect(spec.kind).toBe('pull');
    expect(spec.url).toBe('https://registry.example/machines/java_machine');
  });

  test('pull entries are never mistaken for attach entries', () => {
    const spec = parseMachineEntry('m', 'machinen+pull+http://127.0.0.1:3802');
    expect(spec.kind).toBe('pull');
    // And plain attach keeps working untouched.
    expect(parseMachineEntry('m', 'machinen+http://127.0.0.1:3802').kind).toBe('attach');
  });

  test('formatMachineEntry round-trips pull entries deterministically', () => {
    const entry = 'machinen+pull+http://127.0.0.1:3802?artifact=image';
    expect(formatMachineEntry(parseMachineEntry('m', entry))).toBe(entry);
  });

  test('rejects pull entries with non-http(s) transports', () => {
    expect(() => parseMachineEntry('m', 'machinen+pull+ftp://files.example/m')).toThrow(
      /pull entries must use http/i,
    );
    expect(() => parseMachineEntry('m', 'machinen+pull+://no-scheme')).toThrow(
      /pull entries must use http/i,
    );
  });
});
