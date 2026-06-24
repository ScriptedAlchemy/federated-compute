import type { ExposedFunction } from '@federated-compute/machinen-plugin/guest';
import { progress, start, stop } from './solver';

function fib(n: number): number {
  return n <= 1 ? n : fib(n - 1) + fib(n - 2);
}

const SOLVER_PROGRESS_RETURNS =
  '{ running: boolean; iteration: number; cacheSize: number; cacheCapacity: number; best: number; fingerprint: string; pid: number }';

// Warm state that survives snapshot/restore.
let counter = 0;
const fluidInbox: { from: string; chunk: string; at: string }[] = [];

export const state = {
  dehydrate: () => ({ counter }),
  rehydrate: (saved: unknown) => {
    counter = (saved as { counter?: number })?.counter ?? 0;
  },
};

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
  './counter': {
    increment: { handler: () => ++counter, params: [], returns: 'number' },
    current: { handler: () => counter, params: [], returns: 'number' },
  },
  './fluid': {
    compute: {
      handler: (query: string, placement: string) => {
        const words = query.trim().split(/\s+/).filter(Boolean);
        return {
          chunk: `${words.slice(0, 8).join(' ')}${words.length > 8 ? ' ...' : ''}`.toUpperCase(),
          words: words.length,
          placement,
          pid: process.pid,
          node: process.version,
        };
      },
      params: [
        { name: 'query', type: 'string' },
        { name: 'placement', type: 'string' },
      ],
      returns: '{ chunk: string; words: number; placement: string; pid: number; node: string }',
    },
    acceptBackhaul: {
      handler: (from: string, chunk: string) => {
        fluidInbox.push({ from, chunk, at: new Date().toISOString() });
        return {
          accepted: true,
          inboxSize: fluidInbox.length,
          from,
          pid: process.pid,
        };
      },
      params: [
        { name: 'from', type: 'string' },
        { name: 'chunk', type: 'string' },
      ],
      returns: '{ accepted: boolean; inboxSize: number; from: string; pid: number }',
    },
    inbox: {
      handler: () => fluidInbox.slice(-8),
      params: [],
      returns: '{ from: string; chunk: string; at: string }[]',
    },
  },
  // The whole-VM demo workload. Deliberately NOT covered by `state` above:
  // its heap (memo cache, RNG state, iteration count) only survives a
  // whole-VM vmstate snapshot — telemetry is not serialization.
  './solver': {
    start: {
      handler: start,
      params: [],
      returns: SOLVER_PROGRESS_RETURNS,
    },
    stop: {
      handler: stop,
      params: [],
      returns: SOLVER_PROGRESS_RETURNS,
    },
    progress: {
      handler: progress,
      params: [],
      returns: SOLVER_PROGRESS_RETURNS,
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
  './admin': {
    // Chaos hook for the resilience demo: the machine kills itself shortly
    // after answering, so the caller gets a clean response and every later
    // call hits a genuinely dead process. Same trust model as the rest of
    // the guest protocol: deliberately unauthenticated, loopback-bound.
    die: {
      handler: () => {
        const delayMs = 100;
        setTimeout(() => process.exit(1), delayMs);
        return { pid: process.pid, exitingInMs: delayMs };
      },
      params: [],
      returns: '{ pid: number; exitingInMs: number }',
    },
  },
};
