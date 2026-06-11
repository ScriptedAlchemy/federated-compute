import http from 'node:http';
import path from 'node:path';
import type { MachinenPlugin } from '@federated-compute/machinen-plugin';
import { errorMessage, json } from './http-util.js';

interface MachineStatus {
  attached: boolean;
  runtime?: string;
  version?: string;
  attachedAt?: number;
  /** Artifact kinds the machine's manifest publishes (pull capability). */
  artifacts?: string[];
}

interface ActivityEvent {
  ts: number;
  kind: 'ready' | 'call' | 'error' | 'crash' | 'circuit' | 'snapshot' | 'restore' | 'pull';
  detail: string;
}

export const machineStatus = new Map<string, MachineStatus>();

/** Fixed-capacity ring buffer: O(1) push, oldest entries overwritten. */
export class RingBuffer<T> {
  private readonly buffer: T[];
  private head = 0;
  private size = 0;

  constructor(private readonly capacity: number) {
    this.buffer = new Array<T>(capacity);
  }

  push(item: T) {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  /** Last n items, newest-last. */
  latest(n: number): T[] {
    const count = Math.min(n, this.size);
    const out: T[] = new Array(count);
    for (let i = 0; i < count; i++) {
      out[i] = this.buffer[(this.head - count + i + this.capacity) % this.capacity];
    }
    return out;
  }
}

export const events = new RingBuffer<ActivityEvent>(200);

export function logEvent(kind: ActivityEvent['kind'], detail: string) {
  events.push({ ts: Date.now(), kind, detail });
}

// The host-side artifact cache, as the resolver actually used it. Counters
// accumulate from onArtifactFetched hook events only — no synthetic data.
export const cacheStats = {
  paths: new Set<string>(),
  hits: 0,
  misses: 0,
  bytes: 0,
  reset() {
    this.paths.clear();
    this.hits = 0;
    this.misses = 0;
    this.bytes = 0;
  },
};

/** Feed a plugin's lifecycle hooks into the dashboard's activity log. */
export function logHooks(p: MachinenPlugin): void {
  p.machineHooks.onMachineReady.on(({ spec, manifest }) => {
    if (machineStatus.has(spec.remoteName)) {
      machineStatus.set(spec.remoteName, {
        attached: true,
        runtime: manifest.metaData?.runtime,
        version: manifest.version,
        attachedAt: Date.now(),
        artifacts: manifest.artifacts ? Object.keys(manifest.artifacts) : undefined,
      });
    }
    logEvent('ready', `${spec.remoteName} attached (${manifest.metaData?.runtime})`);
  });
  p.machineHooks.onArtifactFetched.on(({ spec, resolution }) => {
    cacheStats.paths.add(resolution.localPath);
    if (resolution.fromCache) cacheStats.hits++;
    else cacheStats.misses++;
    cacheStats.bytes += resolution.bytesFetched;
    logEvent(
      'pull',
      `${spec.remoteName} pulled ${resolution.artifact} from ${spec.url} — ` +
        (resolution.fromCache
          ? `image cache HIT, ${resolution.bytesFetched} bytes moved`
          : `${resolution.bytesFetched} bytes fetched`) +
        ` in ${resolution.durationMs}ms`,
    );
  });
  p.machineHooks.afterCall.on(({ spec, module, fn, durationMs }) => {
    logEvent('call', `${spec.remoteName} ${module}#${fn} ${durationMs.toFixed(1)}ms`);
  });
  p.machineHooks.onMachineError.on(({ spec, module, fn, error }) => {
    logEvent('error', `${spec.remoteName} ${module}#${fn} failed: ${errorMessage(error)}`);
  });
  p.machineHooks.onMachineCrash.on(({ spec }) => {
    if (machineStatus.has(spec.remoteName)) {
      machineStatus.set(spec.remoteName, { attached: false });
    }
    logEvent('crash', `${spec.remoteName} became unreachable`);
  });
  p.machineHooks.onCircuitOpen.on(({ spec }) => {
    logEvent('circuit', `${spec.remoteName} circuit open — failing fast`);
  });
  p.machineHooks.onCircuitClose.on(({ spec }) => {
    logEvent('circuit', `${spec.remoteName} circuit closed — calls flow again`);
  });
  p.machineHooks.onSnapshotted.on(({ spec, snapshot }) => {
    const snapFile = (snapshot as { snapFile?: string })?.snapFile;
    logEvent('snapshot', `${spec.remoteName} frozen${snapFile ? ` -> ${path.basename(snapFile)}` : ''}`);
  });
}

export function handleDashboard(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  {
    plugin,
    machines,
    remotes,
    lifecycleBody,
  }: {
    plugin: MachinenPlugin;
    machines: readonly { readonly name: string; readonly region: string }[];
    remotes: readonly { readonly entry: string }[];
    lifecycleBody: () => unknown;
  },
) {
  const metrics = plugin.metrics();
  json(res, 200, {
    machines: machines.map(({ name, region }, i) => ({
      name,
      region,
      entry: remotes[i].entry,
      ...machineStatus.get(name),
      metrics: metrics[name] ?? null,
    })),
    lifecycle: lifecycleBody(),
    cache: {
      artifacts: cacheStats.paths.size,
      hits: cacheStats.hits,
      misses: cacheStats.misses,
      bytes: cacheStats.bytes,
    },
    events: events.latest(40),
  });
}
