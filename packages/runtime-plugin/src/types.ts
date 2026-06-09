/** Parsed form of a machine entry.
 *
 * Two transports:
 * - `machinen://<image>?...`        boot a machine from an image (driver owns transport)
 * - `machinen+http://host:port?...` attach to an independently deployed machine
 */
export interface MachineSpec {
  remoteName: string;
  /** The raw entry string. */
  entry: string;
  kind: 'image' | 'attach';
  /** Image/path portion for `kind: 'image'`. */
  image?: string;
  /** Base URL for `kind: 'attach'`. */
  url?: string;
  params: URLSearchParams;
}

export interface FunctionSignature {
  params: { name: string; type: string }[];
  /** TS type of the resolved value (or of each chunk when `stream`). */
  returns: string;
  /** When true the function yields an AsyncIterable of `returns`. */
  stream?: boolean;
}

/** Machine runtime/build metadata — the analog of mf-manifest.json's metaData. */
export interface MachineMetaData {
  /** e.g. "node v22.22.3", "OpenJDK 21.0.11", "cpython 3.12.3" */
  runtime?: string;
  /** Capability flags, e.g. ["stream"]. */
  features?: string[];
  [key: string]: unknown;
}

/**
 * Protocol v3 manifest: the machine analog of `mf-manifest.json`.
 * Served at `/mf-manifest.json`.
 */
export interface MachineExposeManifest {
  name: string;
  protocol: 3;
  /** Semver version of the machine's API surface; negotiated against entry `?version=` ranges. */
  version: string;
  metaData?: MachineMetaData;
  exposes: Record<string, Record<string, FunctionSignature>>;
}

export interface CallOptions {
  /** Cancels the underlying request when supported by the transport. */
  signal?: AbortSignal;
}

/** A booted (or attached) machine the plugin can talk to. */
export interface MachineHandle {
  manifest(): Promise<MachineExposeManifest>;
  call(modulePath: string, fn: string, args: unknown[], opts?: CallOptions): Promise<unknown>;
  /** Required to bind functions declared with `stream: true`. */
  callStream?(modulePath: string, fn: string, args: unknown[]): AsyncIterable<unknown>;
  /** Liveness probe; defaults to manifest reachability when absent. */
  health?(): Promise<boolean>;
  /**
   * Capture/restore the machine's application state — the process-driver
   * simulation of a VM memory dump. A real Machinen driver snapshots the
   * whole VM and does not need these.
   */
  getState?(): Promise<unknown>;
  setState?(state: unknown): Promise<void>;
  /** Freeze the machine's state. Returns a driver-specific descriptor. */
  snapshot?(): Promise<unknown>;
  /** Clone the running machine. Returns a driver-specific descriptor. */
  fork?(): Promise<unknown>;
  dispose?(): Promise<void>;
}

/**
 * Boots or attaches machines. Implementations: in-process (tests), child
 * process, HTTP attach, and eventually a real `@machinen/runtime` driver
 * (provision/boot/restore + port-forwarded guest).
 */
export interface MachineDriver {
  boot(spec: MachineSpec): Promise<MachineHandle>;
}

export interface CallContext {
  spec: MachineSpec;
  module: string;
  fn: string;
  /** Mutable: `beforeCall` listeners may rewrite args. */
  args: unknown[];
}

const IMAGE_PROTOCOL = 'machinen://';
const ATTACH_PREFIX = 'machinen+';

export function isMachineEntry(entry: string): boolean {
  return entry.startsWith(IMAGE_PROTOCOL) || /^machinen\+\w+:\/\//.test(entry);
}

export function parseMachineEntry(remoteName: string, entry: string): MachineSpec {
  const queryIndex = entry.indexOf('?');
  const base = queryIndex === -1 ? entry : entry.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex === -1 ? '' : entry.slice(queryIndex + 1));

  if (base.startsWith(IMAGE_PROTOCOL)) {
    return { remoteName, entry, kind: 'image', image: base.slice(IMAGE_PROTOCOL.length), params };
  }
  if (base.startsWith(ATTACH_PREFIX)) {
    return { remoteName, entry, kind: 'attach', url: base.slice(ATTACH_PREFIX.length), params };
  }
  throw new Error(`[machinen-plugin] not a machine entry: "${entry}"`);
}

/** Inverse of parseMachineEntry: serialize a spec (with possibly edited params) back to an entry string. */
export function formatMachineEntry(spec: MachineSpec): string {
  const base = spec.kind === 'image' ? `${IMAGE_PROTOCOL}${spec.image}` : `${ATTACH_PREFIX}${spec.url}`;
  const query = spec.params.toString();
  return query ? `${base}?${query}` : base;
}

/** `'./math'` -> `'math'` (MF loadRemote id form). */
export function stripExposePrefix(path: string): string {
  return path.startsWith('./') ? path.slice(2) : path;
}

/** `'math'` -> `'./math'` (manifest expose-map form). */
export function normalizeExpose(path: string): string {
  return path.startsWith('.') ? path : `./${path}`;
}
