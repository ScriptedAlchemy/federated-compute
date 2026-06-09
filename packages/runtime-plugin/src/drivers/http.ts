import {
  GuestError,
  MachineAuthError,
  MachineRequestError,
  MachineTransportError,
} from '../errors.js';
import type { MachineDriver, MachineExposeManifest, MachineHandle } from '../types.js';

interface ErrorEnvelope {
  message: string;
  type?: string;
  stack?: string;
}

function guestError(envelope: ErrorEnvelope): GuestError {
  return new GuestError(envelope.message, {
    remoteType: envelope.type,
    remoteStack: envelope.stack,
  });
}

/**
 * Classify a non-2xx guest response. 4xx are deliberate answers from a live
 * guest (401 auth, 413 too large...) — never transport failures, so they are
 * not retried and never trigger restarts. Only 5xx means "machine is gone".
 */
function statusError(what: string, status: number): Error {
  if (status === 401) return new MachineAuthError(`${what} rejected: 401 unauthorized`);
  if (status >= 400 && status < 500) {
    return new MachineRequestError(`${what} rejected by the guest: ${status}`, status);
  }
  return new MachineTransportError(`${what} failed: ${status}`);
}

/**
 * Talk to a machine guest over HTTP. Node's fetch (undici) pools and reuses
 * connections per origin, so repeated calls don't pay a new-connection tax.
 */
export function httpMachineHandle(baseUrl: string, opts: { token?: string } = {}): MachineHandle {
  const base = baseUrl.replace(/\/$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

  async function post(body: unknown, signal?: AbortSignal): Promise<Response> {
    const res = await fetch(`${base}/mf/call`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw statusError('call request', res.status);
    return res;
  }

  return {
    async manifest(): Promise<MachineExposeManifest> {
      const res = await fetch(`${base}/mf-manifest.json`, { headers });
      if (!res.ok) throw statusError('manifest request', res.status);
      return (await res.json()) as MachineExposeManifest;
    },

    async health() {
      try {
        const res = await fetch(`${base}/mf/health`, { headers });
        return res.ok;
      } catch {
        return false;
      }
    },

    async getState() {
      const res = await fetch(`${base}/mf/state`, { headers });
      if (!res.ok) {
        throw new MachineTransportError(`state capture failed: ${res.status} (machine may not support state)`);
      }
      return ((await res.json()) as { state: unknown }).state;
    },

    async setState(state) {
      const res = await fetch(`${base}/mf/state`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ state }),
      });
      if (!res.ok) throw new MachineTransportError(`state restore failed: ${res.status}`);
    },

    async call(modulePath, fn, args, opts) {
      const res = await post({ module: modulePath, fn, args }, opts?.signal);
      const body = (await res.json()) as
        | { ok: true; result: unknown }
        | { ok: false; error: ErrorEnvelope };
      if (!body.ok) throw guestError(body.error);
      return body.result;
    },

    async *callStream(modulePath, fn, args, opts) {
      const res = await post({ module: modulePath, fn, args }, opts?.signal);
      if (!res.body) throw new MachineTransportError('stream response had no body');

      const decoder = new TextDecoder();
      // Split per chunk and carry only the trailing partial line, so long
      // streams stay linear instead of re-slicing one growing buffer.
      let remainder = '';
      for await (const part of res.body) {
        const lines = (remainder + decoder.decode(part as Uint8Array, { stream: true })).split('\n');
        remainder = lines.pop() ?? '';
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          const event = JSON.parse(line) as {
            chunk?: unknown;
            done?: boolean;
            error?: ErrorEnvelope;
          };
          if (event.error) throw guestError(event.error);
          if (event.done) return;
          yield event.chunk;
        }
      }
      // A complete stream always ends with the done (or error) marker; a body
      // that just stops means the connection was cut mid-stream.
      throw new MachineTransportError(
        `stream of ${modulePath}#${fn} ended without a done marker (truncated response)`,
      );
    },
  };
}

/**
 * Driver that attaches to an independently deployed machine over HTTP —
 * the containment-preserving default. The machine is somebody else's deploy;
 * the entry only carries the address (and optionally a token):
 * `machinen+http://127.0.0.1:3802?token=...`
 */
export function httpAttachDriver(): MachineDriver {
  return {
    async boot(spec) {
      if (spec.kind !== 'attach' || !spec.url) {
        throw new Error(
          `[machinen-plugin] httpAttachDriver expects a machinen+http(s):// entry, got "${spec.entry}"`,
        );
      }
      return httpMachineHandle(spec.url, { token: spec.auth?.token });
    },
  };
}
