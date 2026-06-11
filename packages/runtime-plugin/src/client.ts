import { createInstance } from '@module-federation/runtime';
import { loadMachinenConfig, type MachinenConfig } from './config.js';
import { httpAttachDriver } from './drivers/http.js';
import { machinenPlugin, type MachinenPlugin } from './plugin.js';
import type { CallPolicy, MachineMetrics } from './policy.js';
import {
  formatMachineEntry,
  normalizeExpose,
  parseMachineEntry,
  stripExposePrefix,
  type MachineDriver,
} from './types.js';

/**
 * End-user facade. Importing a machine function should feel like importing a
 * local function — no instance wiring, no loadRemote, no plugin setup at call
 * sites. Addresses resolve from config or env:
 *
 *   MACHINEN_REMOTE_<NAME>  machine address (e.g. machinen+http://host:port)
 */
export interface MachinesOptions {
  /** Machine addresses by remote name. Falls back to MACHINEN_REMOTE_* env vars. */
  remotes?: Record<string, string>;
  /** Defaults to httpAttachDriver() — attach to deployed machines. */
  driver?: MachineDriver;
  /**
   * Semver ranges by remote name. Overrides per-module pins from generated
   * bindings, so version policy survives paths (like warm()) that register
   * entries before any binding runs.
   */
  versions?: Record<string, string>;
  calls?: CallPolicy;
  /** Default true: machines restart-and-retry transparently after crashes. */
  restartOnCrash?: boolean;
  /** Timeout for boot + manifest fetch. Default 30s; raise for VM drivers that cold-boot. */
  bootTimeoutMs?: number;
  /**
   * Where to start searching for machinen.config.json (walks upward).
   * Default: process.cwd(). The config is the lowest-precedence source of
   * machine addresses and version pins: options > MACHINEN_REMOTE_* env > config.
   */
  configDir?: string;
  /** Where machinen+pull+ entries cache fetched artifacts. Default: .machinen/cache */
  artifactCacheDir?: string;
  /** Deadline for a pull entry's header/small fetches (manifest, snapshot). Default 30s. */
  artifactFetchTimeoutMs?: number;
  /** Max stall between artifact body chunks before a pull download fails. Default 30s. */
  artifactStreamIdleTimeoutMs?: number;
  /**
   * Enables plugin-owned vmstate publication (plugin.publishMachine() +
   * a lazily started loopback artifact endpoint over `dir`).
   * Default dir: .machinen/registry
   */
  publish?: { dir?: string; hostname?: string; port?: number };
}

export interface MachineModuleOptions {
  /** Semver range pinned onto the entry (MF requiredVersion analog). */
  version?: string;
  /** Function names that stream: bindings return an AsyncIterable instead of a Promise. */
  streams?: string[];
}

type AnyFn = (...args: any[]) => any;
type AnyModule = Record<string, AnyFn>;
type AnyModules = Record<string, AnyModule>;

/** Allows both `machine['./math']` and `machine.math` access, fully typed. */
export type MachineProxy<M extends AnyModules> = M & {
  [K in keyof M as K extends `./${infer S}` ? S : never]: M[K];
};

export interface MachinesClient {
  machine<M extends AnyModules = AnyModules>(
    name: string,
    opts?: MachineModuleOptions,
  ): MachineProxy<M>;
  /** Pre-attach + validate configured machines before serving traffic. */
  warm(remoteNames?: string[]): Promise<void>;
  metrics(): Record<string, MachineMetrics>;
  /** Full hook/snapshot/fork surface for operators. */
  plugin: MachinenPlugin;
}

export function envKeyFor(name: string): string {
  return `MACHINEN_REMOTE_${name.toUpperCase()}`;
}

function stringProp(prop: PropertyKey): prop is string {
  // 'then' is excluded so awaiting a proxy never traps it as a method.
  return typeof prop === 'string' && prop !== 'then';
}

/**
 * A call result that works for both unary (`await fn()`) and streaming
 * (`for await (const x of fn())`) bindings — the actual kind is only known
 * once the machine manifest has loaded, but user-facing types (from bindgen)
 * always say which one to use. The invocation is memoized, so awaiting and
 * iterating the same result never calls the machine twice.
 */
function lazyResult(getFn: Promise<AnyFn>, args: unknown[]): any {
  let pending: Promise<unknown> | undefined;
  const run = () => (pending ??= getFn.then((fn) => fn(...args)));
  return {
    then: (onFulfilled?: any, onRejected?: any) => run().then(onFulfilled, onRejected),
    catch: (onRejected?: any) => run().catch(onRejected),
    finally: (onFinally?: any) => run().finally(onFinally),
    async *[Symbol.asyncIterator]() {
      // Stream bindings return an AsyncIterable synchronously, so run()
      // resolves to the iterable itself.
      yield* (await run()) as AsyncIterable<unknown>;
    },
  };
}

let clientCounter = 0;

export function createMachines(options: MachinesOptions = {}): MachinesClient {
  const plugin = machinenPlugin({
    driver: options.driver ?? httpAttachDriver(),
    restartOnCrash: options.restartOnCrash ?? true,
    bootTimeoutMs: options.bootTimeoutMs,
    calls: options.calls,
    artifactCacheDir: options.artifactCacheDir,
    artifactFetchTimeoutMs: options.artifactFetchTimeoutMs,
    artifactStreamIdleTimeoutMs: options.artifactStreamIdleTimeoutMs,
    publish: options.publish,
  });

  clientCounter++;
  const instance = createInstance({
    name: `machinen_client_${clientCounter}`,
    remotes: [],
    plugins: [plugin],
  });

  const registered = new Map<string, string>();
  const machineProxies = new Map<string, AnyModules>();
  const moduleProxies = new Map<string, AnyModule>();
  const modules = new Map<string, Promise<AnyModule>>();
  const callables = new Map<string, AnyFn>();

  let configLoaded = false;
  let machinenConfig: MachinenConfig | undefined;
  function configFile(): MachinenConfig | undefined {
    if (!configLoaded) {
      machinenConfig = loadMachinenConfig(options.configDir);
      configLoaded = true;
    }
    return machinenConfig;
  }

  function resolveEntry(name: string, opts?: MachineModuleOptions): string {
    const fromConfig = configFile()?.machines[name];
    const base = options.remotes?.[name] ?? process.env[envKeyFor(name)] ?? fromConfig?.url;
    if (!base) {
      const searched = configFile()
        ? `add it to ${configFile()!.path}`
        : 'add a machinen.config.json (none found from the working directory upward)';
      throw new Error(
        `[machinen] no address for machine "${name}". Pass it in createMachines({ remotes }), ` +
          `set ${envKeyFor(name)} (e.g. machinen+http://127.0.0.1:3801), or ${searched}.`,
      );
    }
    const spec = parseMachineEntry(name, base);
    // Priority: explicit ?version= on the entry > client options.versions
    // > module pin > config file pin.
    const version = options.versions?.[name] ?? opts?.version ?? fromConfig?.version;
    if (version && !spec.params.has('version')) spec.params.set('version', version);
    return formatMachineEntry(spec);
  }

  function ensureRegistered(name: string, opts?: MachineModuleOptions): string {
    let entry = registered.get(name);
    if (!entry) {
      entry = resolveEntry(name, opts);
      registered.set(name, entry);
      instance.registerRemotes([{ name, entry }]);
    }
    return entry;
  }

  function loadModule(name: string, modulePath: string, opts?: MachineModuleOptions) {
    const key = `${name}|${modulePath}`;
    let loading = modules.get(key);
    if (!loading) {
      loading = (async () => {
        ensureRegistered(name, opts);
        const mod = await instance.loadRemote<AnyModule>(`${name}/${stripExposePrefix(modulePath)}`);
        if (!mod) throw new Error(`[machinen] module "${modulePath}" not found on "${name}"`);
        return mod;
      })();
      loading.catch(() => modules.delete(key));
      modules.set(key, loading);
    }
    return loading;
  }

  function callable(
    name: string,
    modulePath: string,
    fnName: string,
    opts?: MachineModuleOptions,
  ): AnyFn {
    const key = `${name}|${modulePath}|${fnName}`;
    let fn = callables.get(key);
    if (!fn) {
      const resolved = () =>
        loadModule(name, modulePath, opts).then((mod) => {
          const target = mod[fnName];
          if (typeof target !== 'function') {
            throw new Error(`[machinen] "${name}/${modulePath}" has no function "${fnName}"`);
          }
          return target as AnyFn;
        });
      fn = (...args: unknown[]) => lazyResult(resolved(), args);
      callables.set(key, fn);
    }
    return fn;
  }

  function moduleProxy(name: string, modulePath: string, opts?: MachineModuleOptions): AnyModule {
    const key = `${name}|${modulePath}`;
    let proxy = moduleProxies.get(key);
    if (!proxy) {
      proxy = new Proxy({} as AnyModule, {
        get(_target, fnName) {
          if (!stringProp(fnName)) return undefined;
          return callable(name, modulePath, fnName, opts);
        },
      });
      moduleProxies.set(key, proxy);
    }
    return proxy;
  }

  return {
    machine<M extends AnyModules = AnyModules>(name: string, opts?: MachineModuleOptions) {
      let proxy = machineProxies.get(name);
      if (!proxy) {
        proxy = new Proxy({} as AnyModules, {
          get(_target, moduleName) {
            if (!stringProp(moduleName)) return undefined;
            return moduleProxy(name, normalizeExpose(moduleName), opts);
          },
        });
        machineProxies.set(name, proxy);
      }
      return proxy as MachineProxy<M>;
    },

    async warm(remoteNames) {
      const names =
        remoteNames ?? Object.keys(options.remotes ?? configFile()?.machines ?? {});
      await plugin.warm(names.map((name) => ({ name, entry: ensureRegistered(name) })));
    },

    metrics() {
      return plugin.metrics();
    },

    plugin,
  };
}

// Default client — what generated bindings import, so user code can simply
// `import { math } from './machines/compute_machine'` and call functions.

let defaultOptions: MachinesOptions = {};
let defaultClient: MachinesClient | undefined;

/** Optional bootstrap; without it everything resolves from env vars. */
export function configureMachines(options: MachinesOptions): void {
  if (defaultClient) {
    throw new Error('[machinen] configureMachines() must run before any machine call');
  }
  const versions =
    defaultOptions.versions || options.versions
      ? { ...defaultOptions.versions, ...options.versions }
      : undefined;
  defaultOptions = { ...defaultOptions, ...options, ...(versions ? { versions } : {}) };
}

export function getMachines(): MachinesClient {
  return (defaultClient ??= createMachines(defaultOptions));
}

/** Clears the default client and its options. For tests and hot-reload. */
export function resetMachines(): void {
  defaultClient = undefined;
  defaultOptions = {};
}

function rememberDefaultVersionPin(machineName: string, opts?: MachineModuleOptions): void {
  if (!opts?.version) return;
  defaultOptions.versions ??= {};
  defaultOptions.versions[machineName] ??= opts.version;
}

/**
 * Used by generated bindings: a typed, lazy module bound to the default
 * client. Unlike the dual-shape results of raw machine proxies, typed
 * bindings return the real thing — a Promise for unary functions, an
 * AsyncIterable for functions listed in `opts.streams`.
 */
export function machineModule<M extends AnyModule>(
  machineName: string,
  modulePath: string,
  opts?: MachineModuleOptions,
): M {
  rememberDefaultVersionPin(machineName, opts);
  let mod: AnyModule | undefined;
  const streams = new Set(opts?.streams ?? []);
  const wrappers = new Map<string, AnyFn>();
  const binding = (fnName: string): AnyFn => {
    mod ??= getMachines().machine(machineName, opts)[normalizeExpose(modulePath)];
    return mod[fnName];
  };
  return new Proxy({} as M, {
    get(_target, fnName) {
      if (!stringProp(fnName)) return undefined;
      let wrapper = wrappers.get(fnName);
      if (!wrapper) {
        wrapper = streams.has(fnName)
          ? async function* (...args: unknown[]) {
              yield* binding(fnName)(...args);
            }
          : async (...args: unknown[]) => binding(fnName)(...args);
        wrappers.set(fnName, wrapper);
      }
      return wrapper;
    },
  });
}
