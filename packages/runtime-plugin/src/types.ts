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

/** Protocol v2 manifest: expose paths -> function name -> signature. */
export interface MachineExposeManifest {
  name: string;
  protocol: 2;
  exposes: Record<string, Record<string, FunctionSignature>>;
}

/** A booted (or attached) machine the plugin can talk to. */
export interface MachineHandle {
  manifest(): Promise<MachineExposeManifest>;
  call(modulePath: string, fn: string, args: unknown[]): Promise<unknown>;
  /** Required to bind functions declared with `stream: true`. */
  callStream?(modulePath: string, fn: string, args: unknown[]): AsyncIterable<unknown>;
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
