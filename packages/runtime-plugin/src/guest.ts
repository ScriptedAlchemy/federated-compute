import http from 'node:http';
import { GuestError } from './errors.js';
import type { FunctionSignature, MachineExposeManifest } from './types.js';

type AnyFn = (...args: never[]) => unknown;

/** An exposed function: bare, or annotated with its signature. */
export type ExposedFunction =
  | AnyFn
  | ({ handler: AnyFn } & Partial<FunctionSignature>);

/** Functions a machine guest exposes, keyed by MF-style expose path. */
export interface GuestConfig {
  name: string;
  /** Semver version of this machine's API surface. Default "0.0.0". */
  version?: string;
  metaData?: Record<string, unknown>;
  exposes: Record<string, Record<string, ExposedFunction>>;
  /**
   * Optional state capture for snapshot/restore: dehydrate returns the
   * machine's warm state, rehydrate resumes from it. The process-driver
   * stand-in for a VM memory dump.
   */
  state?: {
    dehydrate(): unknown;
    rehydrate(state: unknown): void;
  };
}

export interface GuestRuntime {
  manifest(): MachineExposeManifest;
  dispatch(modulePath: string, fn: string, args: unknown[]): Promise<unknown>;
  dispatchStream(modulePath: string, fn: string, args: unknown[]): AsyncIterable<unknown>;
  signature(modulePath: string, fn: string): FunctionSignature | undefined;
  /** Present only when the guest config declares state support. */
  state?: GuestConfig['state'];
}

interface NormalizedFn {
  handler: (...args: unknown[]) => unknown;
  signature: FunctionSignature;
}

function normalize(entry: ExposedFunction): NormalizedFn {
  if (typeof entry === 'function') {
    return {
      handler: entry as (...args: unknown[]) => unknown,
      signature: { params: [], returns: 'unknown' },
    };
  }
  return {
    handler: entry.handler as (...args: unknown[]) => unknown,
    signature: {
      params: entry.params ?? [],
      returns: entry.returns ?? 'unknown',
      ...(entry.stream ? { stream: true } : {}),
    },
  };
}

// Identifier-safe names keep host-side property access (machine.math.add) and
// bindgen's generated exports consistent — no sanitization divergence.
const EXPOSE_PATH_RE = /^\.\/[A-Za-z_$][A-Za-z0-9_$]*$/;
const FUNCTION_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The piece that runs *inside* the machine: a registry of exposed functions
 * with a typed manifest, mirroring Module Federation's `exposes` config.
 */
export function createGuestRuntime(config: GuestConfig): GuestRuntime {
  const modules = new Map<string, Map<string, NormalizedFn>>();
  for (const [path, fns] of Object.entries(config.exposes)) {
    if (!EXPOSE_PATH_RE.test(path)) {
      throw new Error(
        `invalid expose path "${path}": expose paths must be './' followed by a valid JS identifier ` +
          `(e.g. './math') — the './' prefix is required — so generated bindings and property access stay consistent`,
      );
    }
    const mod = new Map<string, NormalizedFn>();
    for (const [name, entry] of Object.entries(fns)) {
      if (!FUNCTION_NAME_RE.test(name)) {
        throw new Error(
          `invalid function name "${name}" in expose "${path}": function names must be valid JS identifiers ` +
            `so generated bindings and property access stay consistent`,
        );
      }
      mod.set(name, normalize(entry));
    }
    modules.set(path, mod);
  }

  function lookup(modulePath: string, fn: string): NormalizedFn {
    const mod = modules.get(modulePath);
    if (!mod) throw new Error(`unknown module "${modulePath}"`);
    const target = mod.get(fn);
    if (!target) throw new Error(`module "${modulePath}" has no function "${fn}"`);
    return target;
  }

  const hasStreams = [...modules.values()].some((mod) =>
    [...mod.values()].some(({ signature }) => signature.stream),
  );

  return {
    manifest() {
      const exposes: MachineExposeManifest['exposes'] = {};
      for (const [path, mod] of modules) {
        exposes[path] = Object.fromEntries(
          [...mod].map(([name, { signature }]) => [name, signature]),
        );
      }
      return {
        name: config.name,
        protocol: 3,
        version: config.version ?? '0.0.0',
        metaData: {
          runtime: `node ${process.version}`,
          features: [...(hasStreams ? ['stream'] : []), ...(config.state ? ['state'] : [])],
          ...config.metaData,
        },
        exposes,
      };
    },
    async dispatch(modulePath, fn, args) {
      return await lookup(modulePath, fn).handler(...args);
    },
    dispatchStream(modulePath, fn, args) {
      const target = lookup(modulePath, fn);
      const result = target.handler(...args);
      if (result == null || typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] !== 'function') {
        throw new Error(`function "${fn}" is declared stream but did not return an async iterable`);
      }
      return result as AsyncIterable<unknown>;
    },
    signature(modulePath, fn) {
      return modules.get(modulePath)?.get(fn)?.signature;
    },
    state: config.state,
  };
}

export interface GuestServer {
  port: number;
  close(): Promise<void>;
}

export interface ServeGuestOptions {
  /** Port to listen on; 0 picks a free port. */
  port: number;
  /** Loopback by default — machines should not be reachable off-host unless asked. */
  hostname?: string;
  /** When set, requests must carry `Authorization: Bearer <token>`. */
  token?: string;
}

function errorBody(error: unknown) {
  const err = error as Error;
  return {
    ok: false,
    error: {
      message: err?.message ?? String(error),
      type: err?.name ?? 'Error',
      ...(err?.stack ? { stack: err.stack } : {}),
    },
  };
}

const MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * Serve a guest runtime over HTTP (`GET /mf-manifest.json`, `GET /mf/health`,
 * `POST /mf/call`). Streaming functions respond as NDJSON. In a real Machinen
 * deployment this listens inside the VM on a port-forwarded port.
 */
export function serveGuest(guest: GuestRuntime, opts: ServeGuestOptions): Promise<GuestServer> {
  const hostname = opts.hostname ?? '127.0.0.1';

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/mf/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name: guest.manifest().name }));
        return;
      }
      if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { message: 'unauthorized', type: 'AuthError' } }));
        return;
      }
      if (req.method === 'GET' && req.url === '/mf-manifest.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(guest.manifest()));
        return;
      }
      if (req.url === '/mf/state') {
        if (!guest.state) {
          res.writeHead(501, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: false,
              error: { message: 'state capture not supported by this machine', type: 'StateError' },
            }),
          );
          return;
        }
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, state: guest.state.dehydrate() }));
          return;
        }
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          guest.state.rehydrate(JSON.parse(Buffer.concat(chunks).toString()).state);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
      }
      if (req.method === 'POST' && req.url === '/mf/call') {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += (chunk as Buffer).length;
          if (bytes > MAX_BODY_BYTES) {
            res.writeHead(413, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({ ok: false, error: { message: 'payload too large', type: 'PayloadError' } }),
            );
            return;
          }
          chunks.push(chunk as Buffer);
        }
        const { module: modulePath, fn, args } = JSON.parse(Buffer.concat(chunks).toString());

        const signature = guest.signature(modulePath, fn);
        if (signature?.stream) {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          try {
            for await (const chunk of guest.dispatchStream(modulePath, fn, args ?? [])) {
              res.write(`${JSON.stringify({ chunk })}\n`);
            }
            res.write(`${JSON.stringify({ done: true })}\n`);
          } catch (error) {
            res.write(`${JSON.stringify({ error: errorBody(error).error })}\n`);
          }
          res.end();
          return;
        }

        try {
          const result = await guest.dispatch(modulePath, fn, args ?? []);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (error) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(errorBody(error)));
        }
        return;
      }
      res.writeHead(404);
      res.end();
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify(errorBody(error)));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, hostname, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : opts.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((res2, rej2) => server.close((err) => (err ? rej2(err) : res2()))),
      });
    });
  });
}

export { GuestError };
