import { resolvePullEntry } from './artifacts.js';
import { assertGuestManifestCompatible } from './compatibility.js';
import { isMachinenSnapshotDir } from './drivers/machinen.js';
import { isTransportFailure, MachineCircuitOpenError } from './errors.js';
import type { MachineHooks } from './hooks.js';
import {
  DEFAULT_PUBLISH_DIR,
  publishSnapshotDir,
  startArtifactEndpoint,
  type ArtifactEndpoint,
  type PublishedMachine,
} from './publish.js';
import {
  CircuitBreaker,
  DEFAULT_POLICY,
  MetricsRecorder,
  sleep,
  withTimeout,
  type CallPolicy,
  type CircuitBreakerConfig,
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
import { isVmstateShellIdentity, type VmstateShellIdentity } from './vmstate.js';

export type WarmTarget = string | { name: string; entry: string };
export type RemoteCandidate = { name?: string; entry?: string };

export interface MachineRuntimeSessionOptions {
  driver: MachineDriver;
  hooks: MachineHooks;
  restartOnCrash?: boolean;
  bootTimeoutMs?: number;
  calls?: CallPolicy;
  artifactCacheDir?: string;
  vmstateShell?: VmstateShellIdentity;
  artifactFetchTimeoutMs?: number;
  artifactStreamIdleTimeoutMs?: number;
  publish?: { dir?: string; hostname?: string; port?: number };
}

type AppliedCallPolicy = Required<Omit<CallPolicy, 'circuitBreaker'>> & {
  circuitBreaker: CircuitBreakerConfig | false;
};

interface MachineCapability {
  name: 'snapshot' | 'fork';
  before(hooks: MachineHooks, spec: MachineSpec): Promise<unknown>;
  after(hooks: MachineHooks, spec: MachineSpec, result: unknown): Promise<unknown>;
}

const SNAPSHOT_CAPABILITY: MachineCapability = {
  name: 'snapshot',
  before: (hooks, spec) => hooks.beforeSnapshot.emit({ spec }),
  after: (hooks, spec, snapshot) => hooks.onSnapshotted.emit({ spec, snapshot }),
};

const FORK_CAPABILITY: MachineCapability = {
  name: 'fork',
  before: (hooks, spec) => hooks.beforeFork.emit({ spec }),
  after: (hooks, spec, fork) => hooks.onForked.emit({ spec, fork }),
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

interface UnaryInvocation {
  remoteName: string;
  entry: string;
  modulePath: string;
  fn: string;
}

type UnaryRetryOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: unknown };

export class MachineRuntimeSession {
  private readonly machines = new Map<string, Promise<BootedMachine>>();
  /** Latest boot generation per entry key; crash() only evicts its own generation. */
  private readonly generations = new Map<string, number>();
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly recorders = new Map<string, MetricsRecorder>();
  /** Known machine remotes (captured from init/registerRemotes) for warm(). */
  private readonly knownRemotes = new Map<string, string>();
  private readonly resolutions = new Map<string, Promise<MachineSpec>>();
  private readonly policy: AppliedCallPolicy;
  private endpoint: Promise<ArtifactEndpoint> | undefined;

  constructor(private readonly options: MachineRuntimeSessionOptions) {
    this.policy = { ...DEFAULT_POLICY, ...options.calls };
  }

  rememberRemotes(remotes: RemoteCandidate[] | undefined): void {
    for (const remote of remotes ?? []) {
      if (remote.name && remote.entry && isMachineEntry(remote.entry)) {
        this.knownRemotes.set(remote.name, remote.entry);
      }
    }
  }

  async warm(remotes?: WarmTarget[]): Promise<void> {
    const targets = remotes ?? [...this.knownRemotes.keys()];
    await Promise.all(
      targets.map((target) => {
        if (typeof target !== 'string') {
          return this.ensureMachine(target.name, target.entry);
        }
        const entry = this.knownRemotes.get(target);
        if (!entry) {
          throw new Error(`[machinen-plugin] cannot warm unknown machine "${target}"`);
        }
        return this.ensureMachine(target, entry);
      }),
    );
  }

  metrics(): Record<string, MachineMetrics> {
    return Object.fromEntries(
      [...this.recorders].map(([name, rec]) => [name, rec.snapshot()]),
    );
  }

  async snapshotMachine(remoteName: string): Promise<unknown> {
    return this.runMachineCapability(remoteName, SNAPSHOT_CAPABILITY);
  }

  async forkMachine(remoteName: string): Promise<unknown> {
    return this.runMachineCapability(remoteName, FORK_CAPABILITY);
  }

  private async runMachineCapability(
    remoteName: string,
    capability: MachineCapability,
  ): Promise<unknown> {
    const machine = await this.findMachine(remoteName);
    const run = machine.handle[capability.name];
    if (!run) {
      throw new Error(
        `[machinen-plugin] driver for "${remoteName}" does not support ${capability.name}`,
      );
    }
    await capability.before(this.options.hooks, machine.spec);
    const result = await run.call(machine.handle);
    await capability.after(this.options.hooks, machine.spec, result);
    return result;
  }

  async publishMachine(remoteName: string): Promise<PublishedMachine> {
    const publish = this.options.publish;
    if (!publish) {
      throw new Error(
        `[machinen-plugin] publishMachine("${remoteName}") needs publish options — ` +
          'pass createMachines({ publish: { dir: ".machinen/registry" } })',
      );
    }

    const machine = await this.findMachine(remoteName);
    if (!machine.handle.snapshot) {
      throw new Error(`[machinen-plugin] driver for "${remoteName}" does not support snapshot`);
    }
    await this.options.hooks.beforePublish.emit({ spec: machine.spec });
    await this.options.hooks.beforeSnapshot.emit({ spec: machine.spec });
    const snapshot = await machine.handle.snapshot();
    await this.options.hooks.onSnapshotted.emit({ spec: machine.spec, snapshot });

    const snapDir = (snapshot as { snapDir?: unknown } | undefined)?.snapDir;
    const shell = (snapshot as { shell?: unknown } | undefined)?.shell;
    if (typeof snapDir !== 'string' || !(await isMachinenSnapshotDir(snapDir))) {
      throw new Error(
        `[machinen-plugin] publishMachine("${remoteName}"): the driver's snapshot is not a ` +
          'machinen vmstate bundle directory — whole-VM publication needs machinenDriver() ' +
          '(app-state snapshots travel through ?artifact=snapshot instead)',
      );
    }
    if (!isVmstateShellIdentity(shell)) {
      throw new Error(
        `[machinen-plugin] publishMachine("${remoteName}"): the driver's snapshot did not ` +
          'report a MachineN shell identity',
      );
    }

    const result = await publishSnapshotDir({
      snapDir,
      name: remoteName,
      manifest: machine.manifest,
      layoutDir: publish.dir ?? DEFAULT_PUBLISH_DIR,
      compatibility: { shell },
    });
    const live = await this.ensureEndpoint(publish);
    const published: PublishedMachine = {
      ...result,
      url: `${live.url}/machines/${remoteName}`,
    };
    await this.options.hooks.onPublished.emit({ spec: machine.spec, published });
    return published;
  }

  async dispose(): Promise<void> {
    const closingEndpoint = this.endpoint;
    this.endpoint = undefined;
    if (closingEndpoint) {
      await closingEndpoint.then((live) => live.close()).catch(() => {});
    }

    const booted = await Promise.allSettled(this.machines.values());
    this.machines.clear();
    this.generations.clear();
    this.breakers.clear();
    this.recorders.clear();
    this.knownRemotes.clear();
    this.resolutions.clear();

    // allSettled: one throwing dispose must not abandon the rest.
    await Promise.allSettled(
      booted
        .filter((r): r is PromiseFulfilledResult<BootedMachine> => r.status === 'fulfilled')
        .map((r) => r.value.handle.dispose?.()),
    );
  }

  async loadContainer(remoteName: string, entry: string): Promise<{
    init(): Promise<undefined>;
    get(exposePath: string): Promise<() => Record<string, unknown>>;
  }> {
    // Boot (or attach) now so load-time failures surface here, but have
    // get() re-resolve through the cache: after a crash + reboot, modules
    // must build from the current machine's manifest, not a stale capture.
    await this.ensureMachine(remoteName, entry);
    return {
      init: async () => undefined,
      get: async (exposePath: string) => {
        const machine = await this.ensureMachine(remoteName, entry);
        const moduleExports = this.buildModule(machine, exposePath);
        return () => moduleExports;
      },
    };
  }

  private recorder(remoteName: string): MetricsRecorder {
    let rec = this.recorders.get(remoteName);
    if (!rec) {
      rec = new MetricsRecorder();
      this.recorders.set(remoteName, rec);
    }
    return rec;
  }

  private breaker(entry: string): CircuitBreaker | undefined {
    const breakerConfig = this.policy.circuitBreaker;
    if (breakerConfig === false) return undefined;
    let b = this.breakers.get(entry);
    if (!b) {
      b = new CircuitBreaker(breakerConfig);
      this.breakers.set(entry, b);
    }
    return b;
  }

  private ensureEndpoint(
    publish: NonNullable<MachineRuntimeSessionOptions['publish']>,
  ): Promise<ArtifactEndpoint> {
    this.endpoint ??= startArtifactEndpoint({
      layoutDir: publish.dir ?? DEFAULT_PUBLISH_DIR,
      hostname: publish.hostname,
      port: publish.port,
    });
    return this.endpoint;
  }

  private resolveSpec(remoteName: string, entry: string): Promise<MachineSpec> {
    const parsed = parseMachineEntry(remoteName, entry);
    if (parsed.kind !== 'pull') return Promise.resolve(parsed);

    let resolving = this.resolutions.get(entry);
    if (!resolving) {
      resolving = (async () => {
        await this.options.hooks.beforeArtifactFetch.emit({ spec: parsed });
        const resolution = await resolvePullEntry(parsed, {
          cacheDir: this.options.artifactCacheDir,
          vmstateShell: this.options.vmstateShell,
          fetchTimeoutMs: this.options.artifactFetchTimeoutMs,
          streamIdleTimeoutMs: this.options.artifactStreamIdleTimeoutMs,
        });
        await this.options.hooks.onArtifactFetched.emit({ spec: parsed, resolution });
        return resolution.spec;
      })();
      resolving.catch(() => {
        if (this.resolutions.get(entry) === resolving) this.resolutions.delete(entry);
      });
      this.resolutions.set(entry, resolving);
    }
    return resolving;
  }

  private ensureMachine(remoteName: string, entry: string): Promise<BootedMachine> {
    this.knownRemotes.set(remoteName, entry);
    const cached = this.machines.get(entry);
    if (cached) return cached;

    const generation = (this.generations.get(entry) ?? 0) + 1;
    this.generations.set(entry, generation);

    const boot = (async (): Promise<BootedMachine> => {
      // Pull entries resolve (fetch + cache + rewrite) to local image specs
      // here; drivers only ever see what they already know how to boot.
      const spec = await this.resolveSpec(remoteName, entry);
      await this.options.hooks.beforeMachineBoot.emit({ spec });
      const handle = await this.options.driver.boot(spec);
      try {
        const manifest = await handle.manifest();
        assertGuestManifestCompatible(spec, manifest);
        await this.options.hooks.onMachineReady.emit({ spec, handle, manifest });
        return { key: entry, generation, spec, handle, manifest };
      } catch (error) {
        void handle.dispose?.().catch(() => {});
        throw error;
      }
    })();

    const booting = withTimeout(
      boot,
      this.options.bootTimeoutMs ?? 30_000,
      `boot of machine "${remoteName}"`,
    );
    booting.catch(() => {
      if (this.machines.get(entry) === booting) this.machines.delete(entry);
      // A boot that lost the timeout race may still complete later; nobody
      // will ever use that handle, so dispose it instead of orphaning it.
      void boot.then((machine) => machine.handle.dispose?.()).catch(() => {});
    });
    this.machines.set(entry, booting);
    return booting;
  }

  private async crash(machine: BootedMachine, error: unknown): Promise<void> {
    // Only evict the cache entry while it still belongs to this boot: a
    // concurrent failure may have crashed and rebooted this key already, and
    // deleting blindly would orphan the live rebooted machine.
    if (this.generations.get(machine.key) === machine.generation) {
      this.machines.delete(machine.key);
    }
    // The dead/wedged handle is never reused — release its resources.
    void machine.handle.dispose?.().catch(() => {});
    this.recorder(machine.spec.remoteName).record('crashes');
    await this.options.hooks.onMachineCrash.emit({ spec: machine.spec, error });
  }

  private assertCircuitClosed(
    invocation: UnaryInvocation,
    gate: CircuitBreaker | undefined,
  ): void {
    if ((gate?.gate() ?? 'closed') === 'open') {
      throw new MachineCircuitOpenError(
        `[machinen-plugin] circuit for machine "${invocation.remoteName}" is open; failing fast`,
      );
    }
  }

  private callUnaryOnce(
    invocation: UnaryInvocation,
    machine: BootedMachine,
    args: unknown[],
  ): Promise<unknown> {
    // One controller per attempt: when the deadline trips, the in-flight
    // request is aborted instead of left running against the machine.
    const attempt = new AbortController();
    return withTimeout(
      machine.handle.call(invocation.modulePath, invocation.fn, args, {
        signal: attempt.signal,
      }),
      this.policy.timeoutMs,
      `${invocation.modulePath}#${invocation.fn} on "${invocation.remoteName}"`,
      attempt,
    );
  }

  private async finishUnarySuccess(
    gate: CircuitBreaker | undefined,
    circuitSpec: MachineSpec,
    rec: MetricsRecorder,
    start: number,
    ctx: CallContext,
    result: unknown,
  ): Promise<unknown> {
    if (gate?.onSuccess()) {
      await this.options.hooks.onCircuitClose.emit({ spec: circuitSpec });
    }
    rec.recordDuration(performance.now() - start);
    await this.options.hooks.afterCall.emit({
      ...ctx,
      result,
      durationMs: performance.now() - start,
    });
    return result;
  }

  private async recordUnaryTransportFailure(
    gate: CircuitBreaker | undefined,
    machine: BootedMachine,
    rec: MetricsRecorder,
    error: unknown,
  ): Promise<void> {
    if ((error as Error).name === 'MachineTimeoutError') rec.record('timeouts');
    if (gate?.onTransportFailure()) {
      rec.record('circuitOpens');
      await this.options.hooks.onCircuitOpen.emit({ spec: machine.spec });
    }
  }

  private async callUnaryWithRetries(
    invocation: UnaryInvocation,
    machine: BootedMachine,
    gate: CircuitBreaker | undefined,
    rec: MetricsRecorder,
    start: number,
    ctx: CallContext,
  ): Promise<UnaryRetryOutcome> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.policy.retries; attempt++) {
      if (attempt > 0) {
        rec.record('retries');
        await sleep(this.policy.backoffMs * 2 ** (attempt - 1));
      }
      try {
        const result = await this.callUnaryOnce(invocation, machine, ctx.args);
        return {
          ok: true,
          result: await this.finishUnarySuccess(gate, machine.spec, rec, start, ctx, result),
        };
      } catch (error) {
        if (!isTransportFailure(error)) {
          rec.record('errors');
          await this.options.hooks.onMachineError.emit({ ...ctx, error });
          throw error;
        }
        lastError = error;
        await this.recordUnaryTransportFailure(gate, machine, rec, error);
      }
    }
    return { ok: false, error: lastError };
  }

  private bindUnary(remoteName: string, entry: string, modulePath: string, fn: string) {
    const invocation: UnaryInvocation = { remoteName, entry, modulePath, fn };

    return async (...callArgs: unknown[]): Promise<unknown> => {
      const gate = this.breaker(entry);
      this.assertCircuitClosed(invocation, gate);

      const machine = await this.ensureMachine(remoteName, entry);
      const ctx: CallContext = { spec: machine.spec, module: modulePath, fn, args: callArgs };
      await this.options.hooks.beforeCall.emit(ctx);
      const rec = this.recorder(remoteName);
      rec.record('calls');
      const start = performance.now();

      const retry = await this.callUnaryWithRetries(invocation, machine, gate, rec, start, ctx);
      if (retry.ok) return retry.result;

      // Transport retries exhausted: the machine is gone.
      await this.crash(machine, retry.error);
      if (this.options.restartOnCrash) {
        const rebooted = await this.ensureMachine(remoteName, entry);
        const result = await this.callUnaryOnce(invocation, rebooted, ctx.args);
        return this.finishUnarySuccess(gate, rebooted.spec, rec, start, ctx, result);
      }
      throw retry.error;
    };
  }

  private bindStream(remoteName: string, entry: string, modulePath: string, fn: string) {
    return (...args: unknown[]): AsyncIterable<unknown> => {
      return this.streamCall(remoteName, entry, modulePath, fn, args);
    };
  }

  private async *streamCall(
    remoteName: string,
    entry: string,
    modulePath: string,
    fn: string,
    args: unknown[],
  ): AsyncIterable<unknown> {
    // Streams share the unary circuit breaker: an open circuit fails the
    // stream fast at start, and stream transport failures feed back into
    // it. There is no mid-stream retry or restart — consumers re-invoke.
    const gate = this.breaker(entry);
    this.assertCircuitClosed({ remoteName, entry, modulePath, fn }, gate);

    const machine = await this.ensureMachine(remoteName, entry);
    if (!machine.handle.callStream) {
      throw new Error(
        `[machinen-plugin] "${fn}" is a streaming function but the driver's handle has no callStream`,
      );
    }

    const ctx: CallContext = { spec: machine.spec, module: modulePath, fn, args };
    await this.options.hooks.beforeCall.emit(ctx);
    const rec = this.recorder(remoteName);
    rec.record('calls');
    try {
      yield* machine.handle.callStream(modulePath, fn, ctx.args);
      if (gate?.onSuccess()) {
        await this.options.hooks.onCircuitClose.emit({ spec: machine.spec });
      }
    } catch (error) {
      if (isTransportFailure(error)) {
        if ((error as Error).name === 'MachineTimeoutError') rec.record('timeouts');
        if (gate?.onTransportFailure()) {
          rec.record('circuitOpens');
          await this.options.hooks.onCircuitOpen.emit({ spec: machine.spec });
        }
        await this.crash(machine, error);
      } else {
        rec.record('errors');
        await this.options.hooks.onMachineError.emit({ ...ctx, error });
      }
      throw error;
    }
  }

  private buildModule(machine: BootedMachine, exposePath: string): Record<string, unknown> {
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
        ? this.bindStream(remoteName, machine.key, key, fn)
        : this.bindUnary(remoteName, machine.key, key, fn);
    }
    return moduleExports;
  }

  private async findMachine(remoteName: string): Promise<BootedMachine> {
    for (const booting of this.machines.values()) {
      const machine = await booting.catch(() => undefined);
      if (machine?.spec.remoteName === remoteName) return machine;
    }
    throw new Error(`[machinen-plugin] no booted machine named "${remoteName}"`);
  }
}
