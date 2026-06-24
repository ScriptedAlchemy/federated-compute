import type { ModuleFederationRuntimePlugin } from '@module-federation/runtime';
import { createMachineHooks, type MachineHooks } from './hooks.js';
import { type PublishedMachine } from './publish.js';
import { type CallPolicy, type MachineMetrics } from './policy.js';
import {
  MachineRuntimeSession,
  type RemoteCandidate,
  type WarmTarget,
} from './runtime-session.js';
import { isMachineEntry, type MachineDriver } from './types.js';
import type { VmstateShellIdentity } from './vmstate.js';

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
  /** Local MachineN shell available for vmstate restores. */
  vmstateShell?: VmstateShellIdentity;
  /** Deadline for a pull entry's header/small fetches (manifest, snapshot). Default 30s. */
  artifactFetchTimeoutMs?: number;
  /** Max stall between artifact body chunks before a pull download fails. Default 30s. */
  artifactStreamIdleTimeoutMs?: number;
  /**
   * Enables plugin-owned vmstate publication: publishMachine() writes
   * content-addressed bundles under `dir` and a lazily started loopback
   * endpoint serves them. Plumbing the plugin owns — nothing to deploy.
   */
  publish?: { dir?: string; hostname?: string; port?: number };
}

export type MachinenPlugin = ModuleFederationRuntimePlugin & {
  machineHooks: MachineHooks;
  /** Pre-boot/attach machines (the preloadRemote analog). Accepts names or {name, entry} pairs. */
  warm(remotes?: WarmTarget[]): Promise<void>;
  /** Per-machine call statistics. */
  metrics(): Record<string, MachineMetrics>;
  /** Snapshot a booted machine by remote name (driver permitting). */
  snapshotMachine(remoteName: string): Promise<unknown>;
  /** Fork a booted machine by remote name (driver permitting). */
  forkMachine(remoteName: string): Promise<unknown>;
  /**
   * Snapshot a booted machine's whole VM and publish it as a
   * machinen-vmstate@1 bundle served by the plugin's artifact endpoint.
   * Requires `publish` options and a whole-VM-snapshotting driver
   * (machinenDriver()).
   */
  publishMachine(remoteName: string): Promise<PublishedMachine>;
  /** Dispose every machine this plugin booted (kills child processes etc). */
  disposeMachines(): Promise<void>;
};

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
  const session = new MachineRuntimeSession({ ...options, hooks: machineHooks });

  return {
    name: 'machinen-plugin',
    machineHooks,

    // Capture machine remotes declared at init so warm() can pre-boot them.
    beforeInit(args) {
      session.rememberRemotes(args.userOptions?.remotes as RemoteCandidate[]);
      return args;
    },

    // Capture machine remotes added at runtime via instance.registerRemotes()
    // so warm() accepts them by name too.
    registerRemote(args) {
      session.rememberRemotes([args.remote as RemoteCandidate]);
      return args;
    },

    async warm(remotes) {
      await session.warm(remotes);
    },

    metrics() {
      return session.metrics();
    },

    async snapshotMachine(remoteName) {
      return session.snapshotMachine(remoteName);
    },

    async forkMachine(remoteName) {
      return session.forkMachine(remoteName);
    },

    async publishMachine(remoteName) {
      return session.publishMachine(remoteName);
    },

    async disposeMachines() {
      await session.dispose();
    },

    // Custom remote loading strategy: claim machinen entries and return a
    // virtual container whose get() produces function-binding modules.
    async loadEntry(args) {
      const { remoteInfo } = args as unknown as {
        remoteInfo: { name: string; entry: string };
      };
      if (!remoteInfo?.entry || !isMachineEntry(remoteInfo.entry)) return undefined;

      const container = await session.loadContainer(remoteInfo.name, remoteInfo.entry);
      return container as unknown as ReturnType<
        NonNullable<ModuleFederationRuntimePlugin['loadEntry']>
      >;
    },
  };
}
