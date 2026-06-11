// The Phase 2 hero workload: a long-running route search with visible
// in-memory progress. Everything that matters lives in the heap — the memo
// cache, the RNG state, the iteration count — and NONE of it is covered by
// dehydrate(). An app-state snapshot loses it; a whole-VM vmstate snapshot
// moves it. That asymmetry is the demo.

const GRID = 64; // fixed search space so runs are comparable

// Mutable LCG: the RNG state itself is heap state. A restored VM continues
// the exact same sequence — visible proof the heap moved, not a replay.
let rngState = 0x2026_0611;
function rng(): number {
  rngState = (rngState * 1664525 + 1013904223) >>> 0;
  return rngState / 0x1_0000_0000;
}

let running = false;
let iteration = 0;
let best = Number.POSITIVE_INFINITY;
const memo = new Map<string, number>(); // partial-path costs: the warm cache
let timer: NodeJS.Timeout | undefined;

function pathCost(x: number, y: number): number {
  const key = `${x},${y}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const cost = (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
  const abs = Math.abs(cost);
  memo.set(key, abs);
  return abs;
}

function step(): void {
  // One bounded chunk per tick so the event loop (and /mf/call) stays live.
  for (let i = 0; i < 250; i++) {
    iteration++;
    let x = Math.floor(rng() * GRID);
    let y = Math.floor(rng() * GRID);
    let total = 0;
    for (let hop = 0; hop < 8; hop++) {
      total += pathCost(x, y);
      x = (x + 1 + Math.floor(rng() * 3)) % GRID;
      y = (y + 1 + Math.floor(rng() * 3)) % GRID;
    }
    if (total < best) best = total;
  }
}

/** FNV-1a over the values that define the heap: cheap, deterministic. */
function heapFingerprint(): string {
  let h = 0x811c9dc5;
  const mix = (n: number) => {
    h ^= n >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  mix(iteration);
  mix(memo.size);
  mix(rngState);
  mix(Math.floor(best * 1e9));
  return h.toString(16).padStart(8, '0');
}

export interface SolverProgress {
  running: boolean;
  iteration: number;
  cacheSize: number;
  cacheCapacity: number;
  best: number;
  fingerprint: string;
  pid: number;
}

export function start(): SolverProgress {
  if (!timer) {
    running = true;
    // setInterval survives a vmstate restore (the whole event loop is in the
    // snapshot — that is the point), but unref() matters: an unstarted solver
    // must never keep an idle guest alive.
    timer = setInterval(step, 50);
    timer.unref();
  }
  return progress();
}

export function stop(): SolverProgress {
  if (timer) clearInterval(timer);
  timer = undefined;
  running = false;
  return progress();
}

export function progress(): SolverProgress {
  return {
    running,
    iteration,
    cacheSize: memo.size,
    cacheCapacity: GRID * GRID,
    best: best === Number.POSITIVE_INFINITY ? -1 : Math.round(best * 1e4) / 1e4,
    fingerprint: heapFingerprint(),
    pid: process.pid,
  };
}
