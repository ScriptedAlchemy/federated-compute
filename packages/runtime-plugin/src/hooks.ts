import type { CallContext, MachineExposeManifest, MachineHandle, MachineSpec } from './types.js';

type Listener<T> = (ctx: T) => void | Promise<void>;

/**
 * Minimal async series hook. `@module-federation/runtime-core` does not
 * export its hook classes publicly (as of 2.5.1), so the plugin owns its
 * machine lifecycle hooks with the same tap-and-emit shape.
 */
export class AsyncSeriesHook<T> {
  private listeners: Listener<T>[] = [];

  on(listener: Listener<T>): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  async emit(ctx: T): Promise<T> {
    for (const listener of this.listeners) {
      await listener(ctx);
    }
    return ctx;
  }
}

export interface MachineHooks {
  beforeMachineBoot: AsyncSeriesHook<{ spec: MachineSpec }>;
  onMachineReady: AsyncSeriesHook<{
    spec: MachineSpec;
    handle: MachineHandle;
    manifest: MachineExposeManifest;
  }>;
  beforeCall: AsyncSeriesHook<CallContext>;
  afterCall: AsyncSeriesHook<CallContext & { result: unknown; durationMs: number }>;
  /** A call failed *inside* the machine (guest threw). */
  onMachineError: AsyncSeriesHook<CallContext & { error: unknown }>;
  /** The machine became unreachable (process died, connection refused...). */
  onMachineCrash: AsyncSeriesHook<{ spec: MachineSpec; error: unknown }>;
  /** The circuit breaker opened: calls to this machine now fail fast. */
  onCircuitOpen: AsyncSeriesHook<{ spec: MachineSpec }>;
  /** A half-open probe succeeded: calls flow again. */
  onCircuitClose: AsyncSeriesHook<{ spec: MachineSpec }>;
  beforeSnapshot: AsyncSeriesHook<{ spec: MachineSpec }>;
  onSnapshotted: AsyncSeriesHook<{ spec: MachineSpec; snapshot: unknown }>;
  beforeFork: AsyncSeriesHook<{ spec: MachineSpec }>;
  onForked: AsyncSeriesHook<{ spec: MachineSpec; fork: unknown }>;
}

export function createMachineHooks(): MachineHooks {
  return {
    beforeMachineBoot: new AsyncSeriesHook(),
    onMachineReady: new AsyncSeriesHook(),
    beforeCall: new AsyncSeriesHook(),
    afterCall: new AsyncSeriesHook(),
    onMachineError: new AsyncSeriesHook(),
    onMachineCrash: new AsyncSeriesHook(),
    onCircuitOpen: new AsyncSeriesHook(),
    onCircuitClose: new AsyncSeriesHook(),
    beforeSnapshot: new AsyncSeriesHook(),
    onSnapshotted: new AsyncSeriesHook(),
    beforeFork: new AsyncSeriesHook(),
    onForked: new AsyncSeriesHook(),
  };
}
