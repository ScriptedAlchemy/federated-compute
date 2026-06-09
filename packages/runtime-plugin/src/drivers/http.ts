import { GuestError, MachineTransportError } from '../errors.js';
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
    if (!res.ok) throw new MachineTransportError(`call request failed: ${res.status}`);
    return res;
  }

  return {
    async manifest(): Promise<MachineExposeManifest> {
      const res = await fetch(`${base}/mf-manifest.json`, { headers });
      if (!res.ok) throw new MachineTransportError(`manifest request failed: ${res.status}`);
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

    async call(modulePath, fn, args, opts) {
      const res = await post({ module: modulePath, fn, args }, opts?.signal);
      const body = (await res.json()) as
        | { ok: true; result: unknown }
        | { ok: false; error: ErrorEnvelope };
      if (!body.ok) throw guestError(body.error);
      return body.result;
    },

    async *callStream(modulePath, fn, args) {
      const res = await post({ module: modulePath, fn, args });
      if (!res.body) throw new MachineTransportError('stream response had no body');

      const decoder = new TextDecoder();
      let buffer = '';
      for await (const part of res.body) {
        buffer += decoder.decode(part as Uint8Array, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
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
      return httpMachineHandle(spec.url, { token: spec.params.get('token') ?? undefined });
    },
  };
}
