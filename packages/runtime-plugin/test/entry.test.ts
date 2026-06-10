import { describe, expect, test } from 'vitest';
import { formatMachineEntry, isMachineEntry, parseMachineEntry, redactEntry } from '../src/types.js';

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
    const spec = parseMachineEntry('m', 'machinen+http://127.0.0.1:3802?token=secret');
    expect(spec.kind).toBe('attach');
    expect(spec.url).toBe('http://127.0.0.1:3802');
  });

  test('attach entries keep any path component', () => {
    const spec = parseMachineEntry('m', 'machinen+https://machines.example.com/math');
    expect(spec.kind).toBe('attach');
    expect(spec.url).toBe('https://machines.example.com/math');
  });

  test('tokens move out-of-band: spec.auth carries them, params/entry never do', () => {
    const spec = parseMachineEntry('m', 'machinen+http://127.0.0.1:3802?token=secret&cpus=2');
    expect(spec.auth?.token).toBe('secret');
    expect(spec.params.has('token')).toBe(false);
    expect(spec.params.get('cpus')).toBe('2');
    expect(spec.entry).not.toContain('secret');
    expect(spec.entry).toBe('machinen+http://127.0.0.1:3802?cpus=2');
  });

  test('formatMachineEntry re-includes auth by default and omits it when redacting', () => {
    const spec = parseMachineEntry('m', 'machinen://images/m.img?cpus=1&token=hush');
    expect(formatMachineEntry(spec)).toContain('token=hush');
    const redacted = formatMachineEntry(spec, { redact: true });
    expect(redacted).not.toContain('hush');
    expect(redacted).toContain('cpus=1');
  });

  test('parse errors for non-machine entries never echo the token', () => {
    expect(() => parseMachineEntry('m', 'https://cdn.example.com/x.js?token=hush')).toThrow(
      /not a machine entry/,
    );
    try {
      parseMachineEntry('m', 'https://cdn.example.com/x.js?token=hush');
    } catch (error) {
      expect((error as Error).message).not.toContain('hush');
    }
  });

  test('redactEntry masks every token value in a raw entry string', () => {
    expect(redactEntry('machinen+http://h:1?a=1&token=hush&b=2')).toBe(
      'machinen+http://h:1?a=1&token=[REDACTED]&b=2',
    );
  });
});
