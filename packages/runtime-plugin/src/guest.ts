import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { generateBindings, isJsReservedWord } from './bindgen.js';
import { GuestError } from './errors.js';
import type { ArtifactDescriptor, FunctionSignature, MachineExposeManifest } from './types.js';

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
   * machine's warm state, rehydrate resumes from it. This is how
   * process-driver snapshots work; machinen-backed machines don't need it —
   * `machinenDriver()` dumps the whole VM.
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
    if (!EXPOSE_PATH_RE.test(path) || isJsReservedWord(path.slice(2))) {
      throw new Error(
        `invalid expose path "${path}": expose paths must be './' followed by a valid, non-reserved JS identifier ` +
          `(e.g. './math') — the './' prefix is required — so generated bindings and property access stay consistent`,
      );
    }
    const mod = new Map<string, NormalizedFn>();
    for (const [name, entry] of Object.entries(fns)) {
      if (!FUNCTION_NAME_RE.test(name) || isJsReservedWord(name)) {
        throw new Error(
          `invalid function name "${name}" in expose "${path}": function names must be valid, non-reserved JS identifiers ` +
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
  /**
   * Include guest stack traces in error envelopes. Default false: stacks
   * reveal file paths and internals, so sending them is a deliberate choice.
   */
  exposeStacks?: boolean;
  /**
   * Path to this guest's own program artifact (usually `process.argv[1]`).
   * Enables pull federation: the manifest advertises an `artifacts` block,
   * `GET /mf-image` serves the program, and — when the guest also has state
   * support — `GET /mf-snapshot` serves fresh warm clones. Off by default:
   * anyone who can reach the guest can take its code (and with snapshots,
   * its memory), so publishing artifacts is a deliberate choice.
   */
  imagePath?: string;
}

/** Drivers pick boot commands by extension, so cached pulls must keep it. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.jar': 'application/java-archive',
  '.py': 'text/x-python',
};

interface ImageArtifact {
  bytes: Buffer;
  descriptor: ArtifactDescriptor;
}

async function loadImageArtifact(imagePath: string): Promise<ImageArtifact> {
  let bytes: Buffer;
  try {
    bytes = await readFile(imagePath);
  } catch (error) {
    throw new Error(
      `[machinen-guest] imagePath "${imagePath}" is not readable: ${(error as Error).message}`,
    );
  }
  const ext = path.extname(imagePath);
  return {
    bytes,
    descriptor: {
      href: '/mf-image',
      format: 'guest-bundle',
      mediaType: IMAGE_MEDIA_TYPES[ext] ?? 'application/octet-stream',
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      ext,
      bytes: bytes.length,
      platform: 'any',
    },
  };
}

const SNAPSHOT_DESCRIPTOR: ArtifactDescriptor = {
  href: '/mf-snapshot',
  format: 'app-state@1',
  platform: 'any',
};

function errorBody(error: unknown, exposeStacks: boolean) {
  const err = error as Error;
  return {
    ok: false,
    error: {
      message: err?.message ?? String(error),
      type: err?.name ?? 'Error',
      ...(exposeStacks && err?.stack ? { stack: err.stack } : {}),
    },
  };
}

const MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * Canonical malformed-request answer (shared by all reference guests): HTTP
 * 400 with a constant envelope. The message is deliberately fixed — echoing
 * any part of the body would reflect attacker-controlled content.
 */
function sendParseError(res: http.ServerResponse): void {
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({ ok: false, error: { message: 'malformed request body', type: 'ParseError' } }),
  );
}

/**
 * Read a JSON-object request body. Answers 413 past the cap and 400 for
 * bodies that don't parse to a JSON object, returning undefined either way.
 */
async function readJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += (chunk as Buffer).length;
    if (bytes > MAX_BODY_BYTES) {
      // connection: close — the request will never complete, so the socket
      // cannot be reused; without it the connection lingers half-open.
      res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
      res.end(
        JSON.stringify({ ok: false, error: { message: 'payload too large', type: 'PayloadError' } }),
      );
      // Drain the rest of the upload so the client can read the 413 instead
      // of stalling on a back-pressured socket.
      req.resume();
      return undefined;
    }
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    sendParseError(res);
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendParseError(res);
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

/**
 * Serve a guest runtime over HTTP (`GET /mf-manifest.json`, `GET /mf/health`,
 * `POST /mf/call`). Streaming functions respond as NDJSON. Under
 * `machinenDriver()` this listens inside the microVM behind a port forward.
 * With `imagePath` the guest also publishes pull-federation artifacts
 * (`GET /mf-image`, `GET /mf-snapshot`).
 */
export async function serveGuest(guest: GuestRuntime, opts: ServeGuestOptions): Promise<GuestServer> {
  const hostname = opts.hostname ?? '127.0.0.1';
  const exposeStacks = opts.exposeStacks ?? false;
  const guestName = guest.manifest().name;
  // Read + hash once at startup: a missing image fails the boot loudly, and
  // /mf-image can never drift from the digest the manifest advertised.
  const image = opts.imagePath ? await loadImageArtifact(opts.imagePath) : undefined;
  const artifacts: MachineExposeManifest['artifacts'] = image
    ? { image: image.descriptor, ...(guest.state ? { snapshot: SNAPSHOT_DESCRIPTOR } : {}) }
    : undefined;

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/mf/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name: guestName }));
        return;
      }
      if (req.method === 'GET' && req.url === '/mf-manifest.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...guest.manifest(), ...(artifacts ? { artifacts } : {}) }));
        return;
      }
      if (req.method === 'GET' && req.url === '/mf-image' && image) {
        res.writeHead(200, {
          'content-type': image.descriptor.mediaType ?? 'application/octet-stream',
          'content-length': image.bytes.length,
          'x-mf-digest': image.descriptor.digest!,
          'x-mf-format': image.descriptor.format,
        });
        res.end(image.bytes);
        return;
      }
      if (req.method === 'GET' && req.url === '/mf-snapshot' && image && guest.state) {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(
          JSON.stringify({
            name: guestName,
            imageDigest: image.descriptor.digest,
            state: guest.state.dehydrate(),
            createdAt: new Date().toISOString(),
          }),
        );
        return;
      }
      // Type distribution: the machine's own bindings, MF's @mf-types analog.
      if (req.method === 'GET' && req.url === '/mf-types.ts') {
        res.writeHead(200, { 'content-type': 'application/typescript' });
        res.end(generateBindings(guest.manifest()));
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
          const body = await readJsonBody(req, res);
          if (!body) return;
          try {
            guest.state.rehydrate(body.state);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (error) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(errorBody(error, exposeStacks)));
          }
          return;
        }
      }
      if (req.method === 'POST' && req.url === '/mf/call') {
        const body = await readJsonBody(req, res);
        if (!body) return;
        const { module: modulePath, fn, args } = body as {
          module: string;
          fn: string;
          args?: unknown[];
        };

        const signature = guest.signature(modulePath, fn);
        if (signature?.stream) {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          // Respect socket backpressure (wait for 'drain' when the buffer is
          // full) and stop producing as soon as the connection goes away.
          const closed = new AbortController();
          res.once('close', () => closed.abort());
          const write = async (line: string) => {
            if (!res.write(line)) {
              await once(res, 'drain', { signal: closed.signal }).catch(() => {});
            }
          };
          try {
            for await (const chunk of guest.dispatchStream(modulePath, fn, args ?? [])) {
              if (closed.signal.aborted) break;
              await write(`${JSON.stringify({ chunk })}\n`);
            }
            if (!closed.signal.aborted) await write(`${JSON.stringify({ done: true })}\n`);
          } catch (error) {
            if (!closed.signal.aborted) {
              await write(`${JSON.stringify({ error: errorBody(error, exposeStacks).error })}\n`);
            }
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
          res.end(JSON.stringify(errorBody(error, exposeStacks)));
        }
        return;
      }
      res.writeHead(404);
      res.end();
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify(errorBody(error, exposeStacks)));
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
