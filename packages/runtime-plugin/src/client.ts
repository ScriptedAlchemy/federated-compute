import { createInstance } from '@module-federation/runtime';
import { httpAttachDriver } from './drivers/http.js';
import { machinenPlugin, type MachinenPlugin } from './plugin.js';
import type { CallPolicy, MachineMetrics } from './policy.js';
import type { MachineDriver } from './types.js';

/**
 * End-user facade. The goal: importing a machine function should feel like
 * importing a local function — no instance wiring, no loadRemote, no plugin
 * setup at call sites. Addresses and auth resolve from config or env:
 *
 *   MACHINEN_REMOTE_<NAME>  machine address (e.g. machinen+http://host:port)
 *   MACHINEN_TOKEN          bearer token, appended automatically
 */
export interface MachinesOptions {
  /** Machine addresses by remote name. Falls back to MACHINEN_REMOTE_* env vars. */
  remotes?: Record<string, string>;
  /** Defaults to httpAttachDriver() — attach to deployed machines. */
  driver?: MachineDriver;
  /** Defaults to the MACHINEN_TOKEN env var. */
  token?: string;
  calls?: CallPolicy;
  /** Default true: machines restart-and-retry transparently after crashes. */
  restartOnCrash?: boolean;
}

export interface MachineModuleOptions {
  /** Semver range pinned onto the entry (MF requiredVersion analog). */
  version?: string;
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

function envKeyFor(name: string): string {
  return `MACHINEN_REMOTE_${name.toUpperCase()}`;
}

function stripDotSlash(path: string): string {
  return path.startsWith('./') ? path.slice(2) : path;
}

/**
 * A call result that works for both unary (`await fn()`) and streaming
 * (`for await (const x of fn())`) bindings — the actual kind is only known
 * once the machine manifest has loaded, but user-facing types (from bindgen)
 * always say which one to use.
 */
function lazyResult(getFn: Promise<AnyFn>, args: unknown[]): any {
  let pending: Promise<unknown> | undefined;
  const run = () => (pending ??= getFn.then((fn) => fn(...args)));
  return {
    then: (onFulfilled?: any, onRejected?: any) => run().then(onFulfilled, onRejected),
    catch: (onRejected?: any) => run().catch(onRejected),
    finally: (onFinally?: any) => run().finally(onFinally),
    async *[Symbol.asyncIterator]() {
      const fn = await getFn;
      yield* fn(...args) as AsyncIterable<unknown>;
    },
  };
}

let clientCounter = 0;

export function createMachines(options: MachinesOptions = {}): MachinesClient {
  const plugin = machinenPlugin({
    driver: options.driver ?? httpAttachDriver(),
    restartOnCrash: options.restartOnCrash ?? true,
    calls: options.calls,
  });

  clientCounter++;
  const instance = createInstance({
    name: `machinen_client_${clientCounter}`,
    remotes: [],
    plugins: [plugin],
  });

  const registered = new Map<string, string>();
  const modules = new Map<string, Promise<AnyModule>>();

  function resolveEntry(name: string, opts?: MachineModuleOptions): string {
    const base = options.remotes?.[name] ?? process.env[envKeyFor(name)];
    if (!base) {
      throw new Error(
        `[machinen] no address for machine "${name}". Pass it in createMachines({ remotes }) or set ${envKeyFor(name)}.`,
      );
    }
    const queryIndex = base.indexOf('?');
    const params = new URLSearchParams(queryIndex === -1 ? '' : base.slice(queryIndex + 1));
    const token = options.token ?? process.env.MACHINEN_TOKEN;
    if (token && !params.has('token')) params.set('token', token);
    if (opts?.version && !params.has('version')) params.set('version', opts.version);
    const path = queryIndex === -1 ? base : base.slice(0, queryIndex);
    const query = params.toString();
    return query ? `${path}?${query}` : path;
  }

  function ensureRegistered(name: string, opts?: MachineModuleOptions): void {
    if (registered.has(name)) return;
    const entry = resolveEntry(name, opts);
    registered.set(name, entry);
    instance.registerRemotes([{ name, entry }]);
  }

  function loadModule(name: string, modulePath: string, opts?: MachineModuleOptions) {
    const key = `${name}|${modulePath}`;
    let loading = modules.get(key);
    if (!loading) {
      loading = (async () => {
        ensureRegistered(name, opts);
        const mod = await instance.loadRemote<AnyModule>(`${name}/${stripDotSlash(modulePath)}`);
        if (!mod) throw new Error(`[machinen] module "${modulePath}" not found on "${name}"`);
        return mod;
      })();
      loading.catch(() => modules.delete(key));
      modules.set(key, loading);
    }
    return loading;
  }

  function moduleProxy(name: string, modulePath: string, opts?: MachineModuleOptions): AnyModule {
    return new Proxy({} as AnyModule, {
      get(_target, fnName) {
        if (typeof fnName !== 'string' || fnName === 'then') return undefined;
        return (...args: unknown[]) =>
          lazyResult(
            loadModule(name, modulePath, opts).then((mod) => {
              const fn = mod[fnName];
              if (typeof fn !== 'function') {
                throw new Error(`[machinen] "${name}/${modulePath}" has no function "${fnName}"`);
              }
              return fn;
            }),
            args,
          );
      },
    });
  }

  return {
    machine<M extends AnyModules = AnyModules>(name: string, opts?: MachineModuleOptions) {
      return new Proxy({} as MachineProxy<M>, {
        get(_target, moduleName) {
          if (typeof moduleName !== 'string' || moduleName === 'then') return undefined;
          return moduleProxy(name, moduleName, opts);
        },
      });
    },

    async warm(remoteNames) {
      const names = remoteNames ?? Object.keys(options.remotes ?? {});
      for (const name of names) ensureRegistered(name);
      await plugin.warm(names.map((name) => ({ name, entry: registered.get(name)! })));
    },

    metrics() {
      return plugin.metrics();
    },

    plugin,
  };
}

// ---------------------------------------------------------------------------
// Default client — what generated bindings import, so user code can simply
// `import { math } from './machines/compute_machine'` and call functions.
// ---------------------------------------------------------------------------

let defaultOptions: MachinesOptions = {};
let defaultClient: MachinesClient | undefined;

/** Optional bootstrap; without it everything resolves from env vars. */
export function configureMachines(options: MachinesOptions): void {
  if (defaultClient) {
    throw new Error('[machinen] configureMachines() must run before any machine call');
  }
  defaultOptions = { ...defaultOptions, ...options };
}

export function getMachines(): MachinesClient {
  return (defaultClient ??= createMachines(defaultOptions));
}

/** Used by generated bindings: a typed, lazy module bound to the default client. */
export function machineModule<M extends AnyModule>(
  machineName: string,
  modulePath: string,
  opts?: MachineModuleOptions,
): M {
  return new Proxy({} as M, {
    get(_target, fnName) {
      if (typeof fnName !== 'string' || fnName === 'then') return undefined;
      const mod = getMachines().machine(machineName, opts) as Record<string, AnyModule>;
      return mod[modulePath][fnName];
    },
  });
}
