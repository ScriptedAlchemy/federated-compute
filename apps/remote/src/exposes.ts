import type { ExposedFunction } from '@federated-compute/machinen-plugin/guest';

function fib(n: number): number {
  return n <= 1 ? n : fib(n - 1) + fib(n - 2);
}

/**
 * The machine's "exposes" map — the moral equivalent of Module Federation's
 * `exposes` build config, except these run inside the machine and the host
 * sees them as imported async functions. Signatures feed bindgen.
 */
export const exposes: Record<string, Record<string, ExposedFunction>> = {
  './math': {
    add: {
      handler: (a: number, b: number) => a + b,
      params: [
        { name: 'a', type: 'number' },
        { name: 'b', type: 'number' },
      ],
      returns: 'number',
    },
    fib: {
      handler: fib,
      params: [{ name: 'n', type: 'number' }],
      returns: 'number',
    },
    countdown: {
      handler: async function* (from: number) {
        for (let i = from; i >= 0; i--) yield i;
      },
      params: [{ name: 'from', type: 'number' }],
      returns: 'number',
      stream: true,
    },
  },
  './text': {
    shout: {
      handler: (s: string) => `${s.toUpperCase()}!`,
      params: [{ name: 's', type: 'string' }],
      returns: 'string',
    },
    reverse: {
      handler: (s: string) => [...s].reverse().join(''),
      params: [{ name: 's', type: 'string' }],
      returns: 'string',
    },
  },
  './system': {
    whereAmI: {
      handler: () => ({
        pid: process.pid,
        platform: process.platform,
        node: process.version,
        hint: 'this ran inside the machine, not in the host process',
      }),
      params: [],
      returns: '{ pid: number; platform: string; node: string; hint: string }',
    },
  },
};
