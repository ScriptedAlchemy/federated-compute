import type { ModuleFederationRuntimePlugin } from '@module-federation/runtime';
import semverSatisfies from 'semver/functions/satisfies.js';
import semverValid from 'semver/functions/valid.js';
import { isTransportFailure, MachineCircuitOpenError, MachineVersionError } from './errors.js';
import { createMachineHooks, type MachineHooks } from './hooks.js';
import {
  CircuitBreaker,
  DEFAULT_POLICY,
  MetricsRecorder,
  sleep,
  withTimeout,
  type CallPolicy,
  type MachineMetrics,
} from './policy.js';
import {
  isMachineEntry,
  normalizeExpose,
  parseMachineEntry,
  type CallContext,
  type MachineDriver,
  type MachineExposeManifest,
  type MachineHandle,
  type MachineSpec,
} from './types.js';

export interface MachinenPluginOptions {
  driver: MachineDriver;
  /** Reboot the machine and retry once when a call exhausts transport retries. */
  restartOnCrash?: boolean;
  /** Timeout for boot + manifest fetch. Default 30s. */
  bootTimeoutMs?: number;
  /** Per-call resilience policy (timeout, retries, circuit breaker). */
  calls?: CallPolicy;
}

export type MachinenPlugin = ModuleFederationRuntimePlugin & {
  machineHooks: MachineHooks;
  /** Pre-boot/attach machines (the preloadRemote analog). Accepts names or {name, entry} pairs. */
  warm(remotes?: (string | { name: string; entry: string })[]): Promise<void>;
  /** Per-machine call statistics. */
  metrics(): Record<string, MachineMetrics>;
  /** Snapshot a booted machine by remote name (driver permitting). */
  snapshotMachine(remoteName: string): Promise<unknown>;
  /** Fork a booted machine by remote name (driver permitting). */
  forkMachine(remoteName: string): Promise<unknown>;
  /** Dispose every machine this plugin booted (kills child processes etc). */
  disposeMachines(): Promise<void>;
};

interface BootedMachine {
  spec: MachineSpec;
  handle: MachineHandle;
  manifest: MachineExposeManifest;
}

function checkVersion(spec: MachineSpec, manifest: MachineExposeManifest): void {
  const required = spec.params.get('version');
  if (!required) return;
  const actual = manifest.version;
  if (!actual || !semverValid(actual)) {
    throw new MachineVersionError(
      `[machinen-plugin] entry for "${spec.remoteName}" requires version "${required}" but the machine manifest has no valid version (got "${actual}")`,
    );
  }
  if (!semverSatisfies(actual, required)) {
    throw new MachineVersionError(
      `[machinen-plugin] machine "${spec.remoteName}" version mismatch: required "${required}", machine reports "${actual}"`,
    );
  }
}

/**
 * Module Federation runtime plugin that resolves `machinen://` (boot from
 * image) and `machinen+http://` (attach to a deployed machine) remotes to
 * machines instead of JS bundles. `loadRemote('machine/module')` yields an
 * object of typed async function bindings; each invocation is forwarded into
 * the machine through the driver with deadline/retry/circuit-breaker policy.
 * Federation is the multiplexer and transport — the host never touches a
 * machine's internals.
 */
export function machinenPlugin(options: MachinenPluginOptions): MachinenPlugin {
  const machineHooks = createMachineHooks();
  const machines = new Map<string, Promise<BootedMachine>>();
  const breakers = new Map<string, CircuitBreaker>();
  const recorders = new Map<string, MetricsRecorder>();
  /** Known machine remotes (captured from init/registerRemotes) for warm(). */
  const knownRemotes = new Map<string, string>();

  const policy = { ...DEFAULT_POLICY, ...options.calls };
  const bootTimeoutMs = options.bootTimeoutMs ?? 30_000;

  function recorder(remoteName: string): MetricsRecorder {
    let rec = recorders.get(remoteName);
    if (!rec) {
      rec = new MetricsRecorder();
      recorders.set(remoteName, rec);
    }
    return rec;
  }

  function breaker(entry: string): CircuitBreaker | undefined {
    if (policy.circuitBreaker === false) return undefined;
    let b = breakers.get(entry);
    if (!b) {
      b = new CircuitBreaker(policy.circuitBreaker);
      breakers.set(entry, b);
    }
    return b;
  }

  function rememberRemotes(remotes: { name?: string; entry?: string }[] | undefined): void {
    for (const remote of remotes ?? []) {
      if (remote.name && remote.entry && isMachineEntry(remote.entry)) {
        knownRemotes.set(remote.name, remote.entry);
      }
    }
  }

  function ensureMachine(remoteName: string, entry: string): Promise<BootedMachine> {
    knownRemotes.set(remoteName, entry);
    const cached = machines.get(entry);
    if (cached) return cached;

    const booting = withTimeout(
      (async () => {
        const spec = parseMachineEntry(remoteName, entry);
        await machineHooks.beforeMachineBoot.emit({ spec });
        const handle = await options.driver.boot(spec);
        const manifest = await handle.manifest();
        checkVersion(spec, manifest);
        await machineHooks.onMachineReady.emit({ spec, handle });
        return { spec, handle, manifest };
      })(),
      bootTimeoutMs,
      `boot of machine "${remoteName}"`,
    );
    booting.catch(() => machines.delete(entry));
    machines.set(entry, booting);
    return booting;
  }

  async function crash(machine: BootedMachine, error: unknown): Promise<void> {
    machines.delete(machine.spec.entry);
    recorder(machine.spec.remoteName).record('crashes');
    await machineHooks.onMachineCrash.emit({ spec: machine.spec, error });
  }

  function bindUnary(remoteName: string, entry: string, modulePath: string, fn: string) {
    const callOnce = async (machine: BootedMachine, args: unknown[]): Promise<unknown> => {
      return withTimeout(
        machine.handle.call(modulePath, fn, args),
        policy.timeoutMs,
        `${modulePath}#${fn} on "${remoteName}"`,
      );
    };

    return async (...callArgs: unknown[]): Promise<unknown> => {
      const gate = breaker(entry);
      const state = gate?.gate() ?? 'closed';
      if (state === 'open') {
        throw new MachineCircuitOpenError(
          `[machinen-plugin] circuit for machine "${remoteName}" is open; failing fast`,
        );
      }

      const machine = await ensureMachine(remoteName, entry);
      const ctx: CallContext = { spec: machine.spec, module: modulePath, fn, args: callArgs };
      await machineHooks.beforeCall.emit(ctx);
      const rec = recorder(remoteName);
      rec.record('calls');
      const start = performance.now();

      let lastError: unknown;
      for (let attempt = 0; attempt <= policy.retries; attempt++) {
        if (attempt > 0) {
          rec.record('retries');
          await sleep(policy.backoffMs * 2 ** (attempt - 1));
        }
        try {
          const result = await callOnce(machine, ctx.args);
          if (gate?.onSuccess()) {
            await machineHooks.onCircuitClose.emit({ spec: machine.spec });
          }
          rec.recordDuration(performance.now() - start);
          await machineHooks.afterCall.emit({
            ...ctx,
            result,
            durationMs: performance.now() - start,
          });
          return result;
        } catch (error) {
          if (!isTransportFailure(error)) {
            rec.record('errors');
            await machineHooks.onMachineError.emit({ ...ctx, error });
            throw error;
          }
          lastError = error;
          if ((error as Error).name === 'MachineTimeoutError') rec.record('timeouts');
          if (gate?.onTransportFailure()) {
            rec.record('circuitOpens');
            await machineHooks.onCircuitOpen.emit({ spec: machine.spec });
          }
        }
      }

      // Transport retries exhausted: the machine is gone.
      await crash(machine, lastError);
      if (options.restartOnCrash) {
        const rebooted = await ensureMachine(remoteName, entry);
        const result = await callOnce(rebooted, ctx.args);
        if (gate?.onSuccess()) {
          await machineHooks.onCircuitClose.emit({ spec: rebooted.spec });
        }
        rec.recordDuration(performance.now() - start);
        await machineHooks.afterCall.emit({
          ...ctx,
          result,
          durationMs: performance.now() - start,
        });
        return result;
      }
      throw lastError;
    };
  }

  function bindStream(remoteName: string, entry: string, modulePath: string, fn: string) {
    return (...args: unknown[]): AsyncIterable<unknown> => {
      return (async function* () {
        const machine = await ensureMachine(remoteName, entry);
        if (!machine.handle.callStream) {
          throw new Error(
            `[machinen-plugin] "${fn}" is a streaming function but the driver's handle has no callStream`,
          );
        }
        const ctx: CallContext = { spec: machine.spec, module: modulePath, fn, args };
        await machineHooks.beforeCall.emit(ctx);
        recorder(remoteName).record('calls');
        try {
          yield* machine.handle.callStream(modulePath, fn, ctx.args);
        } catch (error) {
          if (isTransportFailure(error)) {
            await crash(machine, error);
          } else {
            recorder(remoteName).record('errors');
            await machineHooks.onMachineError.emit({ ...ctx, error });
          }
          throw error;
        }
      })();
    };
  }

  function buildModule(machine: BootedMachine, exposePath: string): Record<string, unknown> {
    const key = normalizeExpose(exposePath);
    const signatures = machine.manifest.exposes[key];
    if (!signatures) {
      const available = Object.keys(machine.manifest.exposes).join(', ');
      throw new Error(
        `[machinen-plugin] machine "${machine.spec.remoteName}" does not expose "${key}" (available: ${available})`,
      );
    }
    const { remoteName, entry } = machine.spec;
    const moduleExports: Record<string, unknown> = { __esModule: true };
    for (const [fn, signature] of Object.entries(signatures)) {
      moduleExports[fn] = signature.stream
        ? bindStream(remoteName, entry, key, fn)
        : bindUnary(remoteName, entry, key, fn);
    }
    return moduleExports;
  }

  async function findMachine(remoteName: string): Promise<BootedMachine> {
    for (const booting of machines.values()) {
      const machine = await booting.catch(() => undefined);
      if (machine?.spec.remoteName === remoteName) return machine;
    }
    throw new Error(`[machinen-plugin] no booted machine named "${remoteName}"`);
  }

  return {
    name: 'machinen-plugin',
    machineHooks,

    // Capture machine remotes declared at init so warm() can pre-boot them.
    beforeInit(args) {
      rememberRemotes(args.userOptions?.remotes as { name?: string; entry?: string }[]);
      return args;
    },

    // Capture machine remotes added at runtime via instance.registerRemotes()
    // so warm() accepts them by name too.
    registerRemote(args) {
      rememberRemotes([args.remote as { name?: string; entry?: string }]);
      return args;
    },

    async warm(remotes) {
      const targets = remotes ?? [...knownRemotes.keys()];
      await Promise.all(
        targets.map((target) => {
          if (typeof target !== 'string') {
            return ensureMachine(target.name, target.entry);
          }
          const entry = knownRemotes.get(target);
          if (!entry) {
            throw new Error(`[machinen-plugin] cannot warm unknown machine "${target}"`);
          }
          return ensureMachine(target, entry);
        }),
      );
    },

    metrics() {
      return Object.fromEntries([...recorders].map(([name, rec]) => [name, rec.snapshot()]));
    },

    async snapshotMachine(remoteName) {
      const machine = await findMachine(remoteName);
      if (!machine.handle.snapshot) {
        throw new Error(`[machinen-plugin] driver for "${remoteName}" does not support snapshot`);
      }
      await machineHooks.beforeSnapshot.emit({ spec: machine.spec });
      const snapshot = await machine.handle.snapshot();
      await machineHooks.onSnapshotted.emit({ spec: machine.spec, snapshot });
      return snapshot;
    },

    async forkMachine(remoteName) {
      const machine = await findMachine(remoteName);
      if (!machine.handle.fork) {
        throw new Error(`[machinen-plugin] driver for "${remoteName}" does not support fork`);
      }
      await machineHooks.beforeFork.emit({ spec: machine.spec });
      const fork = await machine.handle.fork();
      await machineHooks.onForked.emit({ spec: machine.spec, fork });
      return fork;
    },

    async disposeMachines() {
      const booted = await Promise.allSettled(machines.values());
      machines.clear();
      for (const result of booted) {
        if (result.status === 'fulfilled') {
          await result.value.handle.dispose?.();
        }
      }
    },

    // Custom remote loading strategy: claim machinen entries and return a
    // virtual container whose get() produces function-binding modules.
    async loadEntry(args) {
      const { remoteInfo } = args as unknown as {
        remoteInfo: { name: string; entry: string };
      };
      if (!remoteInfo?.entry || !isMachineEntry(remoteInfo.entry)) return undefined;

      const machine = await ensureMachine(remoteInfo.name, remoteInfo.entry);
      const container = {
        init: async () => undefined,
        get: async (exposePath: string) => {
          const moduleExports = buildModule(machine, exposePath);
          return () => moduleExports;
        },
      };
      return container as unknown as ReturnType<
        NonNullable<ModuleFederationRuntimePlugin['loadEntry']>
      >;
    },
  };
}
