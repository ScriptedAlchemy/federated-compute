import { describe, expect, test } from 'vitest';
import { buildGuestEnv, processDriver, resolveBootCommand } from '../src/drivers/process.js';
import { parseMachineEntry } from '../src/types.js';

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

describe('processDriver boot failures', () => {
  test('a missing guest binary rejects cleanly instead of crashing the host', async () => {
    const driver = processDriver({
      commands: { '.ghost': (image) => ['no-such-binary-anywhere-9f1c', image] },
    });
    const spec = parseMachineEntry('ghost', 'machinen://guest.ghost');

    // Without a child 'error' listener this is an uncaught ENOENT that takes
    // the whole host process down; it must surface through the boot promise.
    await expect(driver.boot(spec)).rejects.toThrow(/failed to spawn guest process/);
  });

  test('boot failure messages carry the redacted entry, never the token', async () => {
    const driver = processDriver({
      commands: { '.ghost': (image) => ['no-such-binary-anywhere-9f1c', image] },
    });
    const spec = parseMachineEntry('ghost', 'machinen://guest.ghost?token=sekrit');

    const error = (await driver.boot(spec).catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('machinen://guest.ghost');
    expect(error.message).not.toContain('sekrit');
  });
});

describe('buildGuestEnv', () => {
  test('passes only allowlisted and MACHINEN_* vars, never arbitrary host secrets', () => {
    const env = buildGuestEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      AWS_SECRET_ACCESS_KEY: 'leak-me-not',
      GITHUB_TOKEN: 'leak-me-not-either',
      MACHINEN_TYPES_FILE: '/tmp/mf-types.ts',
      MACHINEN_TOKEN: 'guest-config',
    });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.MACHINEN_TYPES_FILE).toBe('/tmp/mf-types.ts');
    expect(env.MACHINEN_TOKEN).toBe('guest-config');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
  });
});
