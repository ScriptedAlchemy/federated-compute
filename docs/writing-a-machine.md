# Writing a machine

A machine is any process, in any language, that speaks the
[guest protocol v3](guest-protocol.md): it serves its typed manifest at
`GET /mf-manifest.json`, answers liveness probes at `GET /mf/health`, and
executes calls posted to `POST /mf/call` — with bearer-token auth on
everything except health, JSON envelopes for results and errors, and NDJSON
for streaming functions. That's the whole contract: implement those three
endpoints and a host can attach, negotiate versions, and import your
functions as typed bindings. See [guest-protocol.md](guest-protocol.md) for
the full wire contract (error envelopes, body caps, status codes, graceful
shutdown).

## Node

`@federated-compute/machinen-plugin/guest` ships the reference
implementation: `createGuestRuntime` builds the registry + manifest from an
`exposes` map (the moral equivalent of MF's `exposes` build config), and
`serveGuest` puts it on HTTP. A complete minimal machine:

```ts
import { createGuestRuntime, serveGuest } from '@federated-compute/machinen-plugin/guest';

const guest = createGuestRuntime({
  name: 'compute_machine',
  version: '1.0.0',
  exposes: {
    './math': {
      add: {
        handler: (a: number, b: number) => a + b,
        params: [
          { name: 'a', type: 'number' },
          { name: 'b', type: 'number' },
        ],
        returns: 'number',
      },
      countdown: {
        handler: async function* (from: number) {
          for (let i = from; i >= 0; i--) yield i;
        },
        params: [{ name: 'from', type: 'number' }],
        returns: 'number',
        stream: true,
      },
    },
  },
});

const server = await serveGuest(guest, {
  port: Number(process.env.PORT ?? 3801),
  token: process.env.MACHINEN_TOKEN || undefined, // bearer auth when set
});
console.log(`machine listening on ${server.port}`);
```

Streaming functions return an async iterable and declare `stream: true`;
`serveGuest` turns them into NDJSON responses. The annotated `params` /
`returns` strings feed the manifest, which is what hosts generate typed
bindings from. `apps/remote` is this exact shape in production trim
(graceful shutdown, snapshot state — see below).

## Java

No SDK required: `apps/remote-java` implements the protocol in plain Java 21
(`src/dev/machinen/*` — server, runtime, modules, state), zero dependencies,
and builds a single `dist/java-machine.jar`. Because the manifest itself
carries full function signatures, a Java (or any non-TS) machine needs no
TypeScript toolchain — hosts render bindings from the manifest alone.

## Python

`apps/remote-python` is the same protocol in Python 3: a `machinen_guest`
package (protocol, registry, server, modules) using only the standard
library.

## Type distribution

Optionally serve `GET /mf-types.ts` — your own generated TS bindings, the
analog of MF's `@mf-types` flow. The Node guest generates it live; the Java
machine's build publishes a static `dist/mf-types.ts` artifact. If you can't
generate it, just 404: hosts fall back to rendering bindings from the
manifest signatures, so the endpoint is a nicety, not a requirement.

## Conformance

`packages/runtime-plugin/test/conformance.test.ts` validates guests against
the protocol. It boots each target through the process driver (the Java jar
and the Python script today; the Node implementation is exercised by the
same assertions in the plugin's own guest tests) and asserts: a protocol-v3
manifest with semver version and typed signatures, an unauthenticated health
endpoint, calls round-tripping JSON values, typed error envelopes for
unknown functions, 401s without the bearer token, the `/mf-types.ts`
static-artifact pattern (200 with content, or 404), state round-trips via
`/mf/state`, the canonical 400 ParseError for malformed and non-object
bodies (with no body reflection and the connection staying live), and a 413
PayloadError for oversized bodies with the guest surviving. To validate a
new guest, add a target entry to the `targets` array — a label, the image
path (the process driver picks the boot command from the extension), the
expected machine name, one sample call, the types expectation, and a
runtime-availability check — and the whole suite runs against it.

## State (optional)

Guests that want app-state snapshot/restore under the process driver declare
the `state` capability: pass `state: { dehydrate, rehydrate }` to
`createGuestRuntime` (or implement `GET/POST /mf/state` directly).
`dehydrate()` returns the machine's warm state; `rehydrate(state)` resumes
from it. Machines run under `machinenDriver()` don't need it — whole-VM
snapshots carry the heap itself.
