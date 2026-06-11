import { AsyncLocalStorage } from 'node:async_hooks';
import type { MachinenPlugin } from '@federated-compute/machinen-plugin';
import { errorMessage } from './http-util.js';

export type WireEvent =
  | {
      type: 'attach';
      machine: string;
      entry: string;
      url?: string;
      version?: string;
      requires?: string;
      runtime?: string;
      /** Set when this boot came from a pulled artifact (provenance). */
      pulledFrom?: string;
      /** The sha256 digest of the image artifact the machine publishes. */
      imageDigest?: string;
    }
  | {
      type: 'call';
      machine: string;
      url?: string;
      module: string;
      fn: string;
      args: string;
      result: string;
      ms: number;
    }
  | { type: 'snapshot'; machine: string; snapFile: string }
  | {
      /** A pull entry resolved: the artifact moved (or the cache answered). */
      type: 'artifact';
      machine: string;
      origin?: string;
      entry: string;
      artifact: string;
      bytes: number;
      digest?: string;
      cacheHit: boolean;
      ms: number;
    }
  | { type: 'crash'; machine: string; error: string }
  | { type: 'circuit'; machine: string; state: 'open' | 'closed' }
  | {
      /**
       * Version negotiation refused an attach. No plugin hook fires for a
       * rejected boot (onMachineReady never runs), so the route records this
       * event itself — `error` is the plugin's MachineVersionError verbatim.
       */
      type: 'reject';
      machine: string;
      entry: string;
      required: string;
      error: string;
    };

export const wireStore = new AsyncLocalStorage<WireEvent[]>();

/** JSON-serialize a value for display, clipped so payloads stay readable. */
export function clip(value: unknown, max = 140): string {
  let s: string;
  try {
    s = JSON.stringify(value) ?? 'undefined';
  } catch {
    s = String(value);
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Record plugin hook events into the current request's wire. */
export function recordWire(p: MachinenPlugin): void {
  p.machineHooks.onMachineReady.on(({ spec, manifest }) => {
    wireStore.getStore()?.push({
      type: 'attach',
      machine: spec.remoteName,
      entry: spec.entry,
      url: spec.url,
      version: manifest.version,
      requires: spec.params.get('version') ?? undefined,
      runtime: manifest.metaData?.runtime,
      pulledFrom: spec.pulledFrom,
      imageDigest: manifest.artifacts?.image?.digest,
    });
  });
  p.machineHooks.onArtifactFetched.on(({ spec, resolution }) => {
    wireStore.getStore()?.push({
      type: 'artifact',
      machine: spec.remoteName,
      origin: spec.url,
      entry: spec.entry,
      artifact: resolution.artifact,
      bytes: resolution.bytesFetched,
      digest: resolution.descriptor.digest,
      cacheHit: resolution.fromCache,
      ms: resolution.durationMs,
    });
  });
  p.machineHooks.afterCall.on(({ spec, module, fn, args, result, durationMs }) => {
    wireStore.getStore()?.push({
      type: 'call',
      machine: spec.remoteName,
      url: spec.url,
      module,
      fn,
      args: clip(args),
      result: clip(result),
      ms: durationMs,
    });
  });
  p.machineHooks.onSnapshotted.on(({ spec, snapshot }) => {
    // Process driver descriptors carry snapFile; machinen (whole-VM) bundles
    // carry snapDir.
    const descriptor = snapshot as { snapFile?: string; snapDir?: string } | undefined;
    const snapFile = descriptor?.snapFile ?? descriptor?.snapDir ?? '(driver descriptor)';
    wireStore.getStore()?.push({ type: 'snapshot', machine: spec.remoteName, snapFile });
  });
  p.machineHooks.onMachineCrash.on(({ spec, error }) => {
    wireStore.getStore()?.push({ type: 'crash', machine: spec.remoteName, error: errorMessage(error) });
  });
  p.machineHooks.onCircuitOpen.on(({ spec }) => {
    wireStore.getStore()?.push({ type: 'circuit', machine: spec.remoteName, state: 'open' });
  });
  p.machineHooks.onCircuitClose.on(({ spec }) => {
    wireStore.getStore()?.push({ type: 'circuit', machine: spec.remoteName, state: 'closed' });
  });
}

/** The wire events captured so far for the current request. */
export function wire(): WireEvent[] {
  return wireStore.getStore() ?? [];
}
