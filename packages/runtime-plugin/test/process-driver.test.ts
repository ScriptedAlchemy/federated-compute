import { describe, expect, test } from 'vitest';
import { resolveBootCommand } from '../src/drivers/process.js';

describe('resolveBootCommand', () => {
  test('node images run with the current node executable', () => {
    expect(resolveBootCommand('/images/guest.js')).toEqual([process.execPath, '/images/guest.js']);
    expect(resolveBootCommand('/images/guest.mjs')).toEqual([
      process.execPath,
      '/images/guest.mjs',
    ]);
  });

  test('java source images run in source-file mode', () => {
    expect(resolveBootCommand('/images/Main.java')).toEqual(['java', '/images/Main.java']);
  });

  test('jar images run with java -jar', () => {
    expect(resolveBootCommand('/images/app.jar')).toEqual(['java', '-jar', '/images/app.jar']);
  });

  test('python images run with python3', () => {
    expect(resolveBootCommand('/images/guest.py')).toEqual(['python3', '/images/guest.py']);
  });

  test('unknown image types throw with a helpful message', () => {
    expect(() => resolveBootCommand('/images/guest.rb')).toThrow(/no boot command/i);
  });

  test('overrides win over built-ins', () => {
    expect(resolveBootCommand('/images/guest.rb', { '.rb': (image) => ['ruby', image] })).toEqual([
      'ruby',
      '/images/guest.rb',
    ]);
  });
});
