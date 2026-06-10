/** Parsed form of a machine entry.
 *
 * Three transports:
 * - `machinen://<image>?...`             boot a machine from a local image (driver owns transport)
 * - `machinen+http://host:port?...`      attach to an independently deployed machine
 * - `machinen+pull+http://host:port?...` fetch the machine's published artifact, then boot it locally
 */
export interface MachineSpec {
  remoteName: string;
  /** The normalized entry string — used for map keys, hooks, and error messages. */
  entry: string;
  kind: 'image' | 'attach' | 'pull';
  /** Image/path portion for `kind: 'image'`. */
  image?: string;
  /** Base URL for `kind: 'attach'` and `kind: 'pull'`. */
  url?: string;
  /** Entry params, parsed verbatim from the query string. */
  params: URLSearchParams;
  /**
   * Provenance: the original `machinen+pull+...` entry this spec was resolved
   * from. Set only on specs rewritten by the artifact resolver.
   */
  pulledFrom?: string;
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
 * Where one of a machine's published artifacts lives and how to verify it —
 * the analog of mf-manifest.json's `remoteEntry` field.
 */
export interface ArtifactDescriptor {
  /** Artifact URL, relative to the manifest origin (or absolute). */
  href: string;
  /** Consumer-side dispatch key: `guest-bundle`, `app-state@1`, `machinen-vmstate@1` (Phase 2). */
  format: string;
  /** `sha256:<hex>` of the artifact bytes. Required for immutable artifacts (image). */
  digest?: string;
  /** File extension (".js", ".jar", ".py"...) the cached artifact must keep so drivers can boot it. */
  ext?: string;
  /** Informational content type (e.g. "application/java-archive"). */
  mediaType?: string;
  /** Artifact size in bytes, when known. */
  bytes?: number;
  /** `any` for app-level artifacts; `linux/amd64` etc. for arch-bound bundles. */
  platform?: string;
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
  /**
   * Published artifacts for pull-and-boot federation. Presence is the
   * capability advertisement — like mf-manifest.json's `remoteEntry` field.
   */
  artifacts?: {
    /** The machine's program — the remoteEntry.js analog. */
    image?: ArtifactDescriptor;
    /** A freshly dehydrated warm snapshot (state + image digest reference). */
    snapshot?: ArtifactDescriptor;
  };
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
  callStream?(
    modulePath: string,
    fn: string,
    args: unknown[],
    opts?: CallOptions,
  ): AsyncIterable<unknown>;
  /** Liveness probe; defaults to manifest reachability when absent. */
  health?(): Promise<boolean>;
  /**
   * Capture/restore the machine's application state — how process-driver
   * snapshots work. The machinen driver snapshots the whole VM and does not
   * need these.
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
 * process (local dev), HTTP attach (deployed machines), and the real
 * `@machinen/runtime` driver (microVM boot/restore + port-forwarded guest).
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
// Must be claimed before the generic attach prefix: the attach test would
// otherwise read "pull" as the transport and attach to a nonsense URL.
const PULL_PREFIX = 'machinen+pull+';

export function isMachineEntry(entry: string): boolean {
  return (
    entry.startsWith(IMAGE_PROTOCOL) ||
    entry.startsWith(PULL_PREFIX) ||
    /^machinen\+\w+:\/\//.test(entry)
  );
}

export function parseMachineEntry(remoteName: string, entry: string): MachineSpec {
  const queryIndex = entry.indexOf('?');
  const base = queryIndex === -1 ? entry : entry.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex === -1 ? '' : entry.slice(queryIndex + 1));

  let spec: MachineSpec;
  if (base.startsWith(IMAGE_PROTOCOL)) {
    spec = { remoteName, entry, kind: 'image', image: base.slice(IMAGE_PROTOCOL.length), params };
  } else if (base.startsWith(PULL_PREFIX)) {
    const url = base.slice(PULL_PREFIX.length);
    if (!/^https?:\/\/.+/.test(url)) {
      throw new Error(
        `[machinen-plugin] pull entries must use http(s) (machinen+pull+http://... or machinen+pull+https://...), got "${entry}"`,
      );
    }
    spec = { remoteName, entry, kind: 'pull', url, params };
  } else if (base.startsWith(ATTACH_PREFIX)) {
    spec = { remoteName, entry, kind: 'attach', url: base.slice(ATTACH_PREFIX.length), params };
  } else {
    throw new Error(`[machinen-plugin] not a machine entry: "${entry}"`);
  }
  spec.entry = formatMachineEntry(spec);
  return spec;
}

/**
 * Inverse of parseMachineEntry: serialize a spec (with possibly edited params)
 * back to an entry string. Deterministic, so the result is safe as a map key.
 */
export function formatMachineEntry(spec: MachineSpec): string {
  let base: string;
  switch (spec.kind) {
    case 'image':
      base = `${IMAGE_PROTOCOL}${spec.image}`;
      break;
    case 'pull':
      base = `${PULL_PREFIX}${spec.url}`;
      break;
    case 'attach':
      base = `${ATTACH_PREFIX}${spec.url}`;
      break;
    default: {
      const unreachable: never = spec.kind;
      throw new Error(`[machinen-plugin] unknown entry kind: ${String(unreachable)}`);
    }
  }
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
