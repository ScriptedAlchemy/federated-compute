import type { ModuleFederationRuntimePlugin } from '@module-federation/runtime';
import { isTransportFailure } from './errors.js';
import { createMachineHooks, type MachineHooks } from './hooks.js';
import {
  isMachineEntry,
  parseMachineEntry,
  type CallContext,
  type MachineDriver,
  type MachineExposeManifest,
  type MachineHandle,
  type MachineSpec,
} from './types.js';

export interface MachinenPluginOptions {
  driver: MachineDriver;
  /** Reboot the machine and retry once when a call hits a transport failure. */
  restartOnCrash?: boolean;
}

export type MachinenPlugin = ModuleFederationRuntimePlugin & {
  machineHooks: MachineHooks;
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

function normalizeExpose(path: string): string {
  return path.startsWith('.') ? path : `./${path}`;
}

/**
 * Module Federation runtime plugin that resolves `machinen://` (boot from
 * image) and `machinen+http://` (attach to a deployed machine) remotes to
 * machines instead of JS bundles. `loadRemote('machine/module')` yields an
 * object of async function bindings; each invocation is forwarded into the
 * machine through the driver. Federation is the multiplexer and transport —
 * the host never touches a machine's internals.
 */
export function machinenPlugin(options: MachinenPluginOptions): MachinenPlugin {
  const machineHooks = createMachineHooks();
  const machines = new Map<string, Promise<BootedMachine>>();

  function ensureMachine(remoteName: string, entry: string): Promise<BootedMachine> {
    const cached = machines.get(entry);
    if (cached) return cached;

    const booting = (async () => {
      const spec = parseMachineEntry(remoteName, entry);
      await machineHooks.beforeMachineBoot.emit({ spec });
      const handle = await options.driver.boot(spec);
      const manifest = await handle.manifest();
      await machineHooks.onMachineReady.emit({ spec, handle });
      return { spec, handle, manifest };
    })();
    booting.catch(() => machines.delete(entry));
    machines.set(entry, booting);
    return booting;
  }

  async function crash(machine: BootedMachine, error: unknown): Promise<void> {
    machines.delete(machine.spec.entry);
    await machineHooks.onMachineCrash.emit({ spec: machine.spec, error });
  }

  function bindUnary(remoteName: string, entry: string, modulePath: string, fn: string) {
    const invoke = async (machine: BootedMachine, args: unknown[]): Promise<unknown> => {
      const ctx: CallContext = { spec: machine.spec, module: modulePath, fn, args };
      await machineHooks.beforeCall.emit(ctx);
      const start = performance.now();
      try {
        const result = await machine.handle.call(modulePath, fn, ctx.args);
        await machineHooks.afterCall.emit({
          ...ctx,
          result,
          durationMs: performance.now() - start,
        });
        return result;
      } catch (error) {
        if (isTransportFailure(error)) {
          await crash(machine, error);
          if (options.restartOnCrash) {
            const rebooted = await ensureMachine(remoteName, entry);
            return invoke(rebooted, ctx.args);
          }
          throw error;
        }
        await machineHooks.onMachineError.emit({ ...ctx, error });
        throw error;
      }
    };

    return async (...args: unknown[]): Promise<unknown> => {
      const machine = await ensureMachine(remoteName, entry);
      return invoke(machine, args);
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
        try {
          yield* machine.handle.callStream(modulePath, fn, ctx.args);
        } catch (error) {
          if (isTransportFailure(error)) {
            await crash(machine, error);
          } else {
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
