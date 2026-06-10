import type { ModuleFederationRuntimePlugin } from '@module-federation/runtime';
import semverSatisfies from 'semver/functions/satisfies.js';
import semverValid from 'semver/functions/valid.js';
import { resolvePullEntry } from './artifacts.js';
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
  /** Timeout for boot + manifest fetch (including pull-entry artifact fetches). Default 30s. */
  bootTimeoutMs?: number;
  /** Per-call resilience policy (timeout, retries, circuit breaker). */
  calls?: CallPolicy;
  /** Where machinen+pull+ entries cache fetched artifacts. Default: .machinen/cache */
  artifactCacheDir?: string;
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
  /** The raw entry string this machine is cached under. */
  key: string;
  /** Boot generation for the key; guards crash() against evicting a newer boot. */
  generation: number;
  spec: MachineSpec;
  handle: MachineHandle;
  manifest: MachineExposeManifest;
}

function validateManifest(spec: MachineSpec, manifest: MachineExposeManifest): void {
  if (manifest?.protocol !== 3) {
    throw new Error(
      `[machinen-plugin] machine "${spec.remoteName}" speaks guest protocol ${String(manifest?.protocol)}, expected 3`,
    );
  }
  if (!manifest.exposes || typeof manifest.exposes !== 'object') {
    throw new Error(
      `[machinen-plugin] machine "${spec.remoteName}" manifest has no "exposes" map`,
    );
  }
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
  /** Latest boot generation per entry key; crash() only evicts its own generation. */
  const generations = new Map<string, number>();
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

  /**
   * Pull-entry resolutions, memoized per entry string and deliberately NOT
   * evicted on crash: restartOnCrash must reboot from the artifact already
   * pulled, never re-fetch newer state mid-incident. Cleared only by
   * disposeMachines(); a failed resolution evicts itself so retries can pull.
   */
  const resolutions = new Map<string, Promise<MachineSpec>>();

  function resolveSpec(remoteName: string, entry: string): Promise<MachineSpec> {
    const parsed = parseMachineEntry(remoteName, entry);
    if (parsed.kind !== 'pull') return Promise.resolve(parsed);
    let resolving = resolutions.get(entry);
    if (!resolving) {
      resolving = (async () => {
        await machineHooks.beforeArtifactFetch.emit({ spec: parsed });
        const resolution = await resolvePullEntry(parsed, { cacheDir: options.artifactCacheDir });
        await machineHooks.onArtifactFetched.emit({ spec: parsed, resolution });
        return resolution.spec;
      })();
      resolving.catch(() => {
        if (resolutions.get(entry) === resolving) resolutions.delete(entry);
      });
      resolutions.set(entry, resolving);
    }
    return resolving;
  }

  function ensureMachine(remoteName: string, entry: string): Promise<BootedMachine> {
    knownRemotes.set(remoteName, entry);
    const cached = machines.get(entry);
    if (cached) return cached;

    const generation = (generations.get(entry) ?? 0) + 1;
    generations.set(entry, generation);

    const boot = (async (): Promise<BootedMachine> => {
      // Pull entries resolve (fetch + cache + rewrite) to local image specs
      // here; drivers only ever see what they already know how to boot.
      const spec = await resolveSpec(remoteName, entry);
      await machineHooks.beforeMachineBoot.emit({ spec });
      const handle = await options.driver.boot(spec);
      try {
        const manifest = await handle.manifest();
        validateManifest(spec, manifest);
        checkVersion(spec, manifest);
        await machineHooks.onMachineReady.emit({ spec, handle, manifest });
        return { key: entry, generation, spec, handle, manifest };
      } catch (error) {
        void handle.dispose?.().catch(() => {});
        throw error;
      }
    })();

    const booting = withTimeout(boot, bootTimeoutMs, `boot of machine "${remoteName}"`);
    booting.catch(() => {
      if (machines.get(entry) === booting) machines.delete(entry);
      // A boot that lost the timeout race may still complete later; nobody
      // will ever use that handle, so dispose it instead of orphaning it.
      void boot.then((machine) => machine.handle.dispose?.()).catch(() => {});
    });
    machines.set(entry, booting);
    return booting;
  }

  async function crash(machine: BootedMachine, error: unknown): Promise<void> {
    // Only evict the cache entry while it still belongs to this boot: a
    // concurrent failure may have crashed and rebooted this key already, and
    // deleting blindly would orphan the live rebooted machine.
    if (generations.get(machine.key) === machine.generation) {
      machines.delete(machine.key);
    }
    // The dead/wedged handle is never reused — release its resources.
    void machine.handle.dispose?.().catch(() => {});
    recorder(machine.spec.remoteName).record('crashes');
    await machineHooks.onMachineCrash.emit({ spec: machine.spec, error });
  }

  function bindUnary(remoteName: string, entry: string, modulePath: string, fn: string) {
    const callOnce = async (machine: BootedMachine, args: unknown[]): Promise<unknown> => {
      // One controller per attempt: when the deadline trips, the in-flight
      // request is aborted instead of left running against the machine.
      const attempt = new AbortController();
      return withTimeout(
        machine.handle.call(modulePath, fn, args, { signal: attempt.signal }),
        policy.timeoutMs,
        `${modulePath}#${fn} on "${remoteName}"`,
        attempt,
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
        // Streams share the unary circuit breaker: an open circuit fails the
        // stream fast at start, and stream transport failures feed back into
        // it. There is no mid-stream retry or restart — consumers re-invoke.
        const gate = breaker(entry);
        if ((gate?.gate() ?? 'closed') === 'open') {
          throw new MachineCircuitOpenError(
            `[machinen-plugin] circuit for machine "${remoteName}" is open; failing fast`,
          );
        }
        const machine = await ensureMachine(remoteName, entry);
        if (!machine.handle.callStream) {
          throw new Error(
            `[machinen-plugin] "${fn}" is a streaming function but the driver's handle has no callStream`,
          );
        }
        const ctx: CallContext = { spec: machine.spec, module: modulePath, fn, args };
        await machineHooks.beforeCall.emit(ctx);
        const rec = recorder(remoteName);
        rec.record('calls');
        try {
          yield* machine.handle.callStream(modulePath, fn, ctx.args);
          if (gate?.onSuccess()) {
            await machineHooks.onCircuitClose.emit({ spec: machine.spec });
          }
        } catch (error) {
          if (isTransportFailure(error)) {
            if ((error as Error).name === 'MachineTimeoutError') rec.record('timeouts');
            if (gate?.onTransportFailure()) {
              rec.record('circuitOpens');
              await machineHooks.onCircuitOpen.emit({ spec: machine.spec });
            }
            await crash(machine, error);
          } else {
            rec.record('errors');
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
    // Bindings capture the raw cache key so a post-crash reboot re-parses
    // the original entry.
    const { remoteName } = machine.spec;
    const moduleExports: Record<string, unknown> = { __esModule: true };
    for (const [fn, signature] of Object.entries(signatures)) {
      moduleExports[fn] = signature.stream
        ? bindStream(remoteName, machine.key, key, fn)
        : bindUnary(remoteName, machine.key, key, fn);
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
      generations.clear();
      breakers.clear();
      recorders.clear();
      knownRemotes.clear();
      resolutions.clear();
      // allSettled: one throwing dispose must not abandon the rest.
      await Promise.allSettled(
        booted
          .filter((r): r is PromiseFulfilledResult<BootedMachine> => r.status === 'fulfilled')
          .map((r) => r.value.handle.dispose?.()),
      );
    },

    // Custom remote loading strategy: claim machinen entries and return a
    // virtual container whose get() produces function-binding modules.
    async loadEntry(args) {
      const { remoteInfo } = args as unknown as {
        remoteInfo: { name: string; entry: string };
      };
      if (!remoteInfo?.entry || !isMachineEntry(remoteInfo.entry)) return undefined;

      // Boot (or attach) now so load-time failures surface here, but have
      // get() re-resolve through the cache: after a crash + reboot, modules
      // must build from the current machine's manifest, not a stale capture.
      await ensureMachine(remoteInfo.name, remoteInfo.entry);
      const container = {
        init: async () => undefined,
        get: async (exposePath: string) => {
          const machine = await ensureMachine(remoteInfo.name, remoteInfo.entry);
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
