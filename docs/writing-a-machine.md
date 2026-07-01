# Writing a machine

A machine is any process, in any language, that speaks the
[guest protocol v3](guest-protocol.md): it serves its typed manifest at
`GET /mf-manifest.json`, answers liveness probes at `GET /mf/health`, and
executes calls posted to `POST /mf/call` — with JSON envelopes for results
and errors, and NDJSON for streaming functions. That's the whole contract: implement those three
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
});
console.log(`machine listening on ${server.port}`);
```

Streaming functions return an async iterable and declare `stream: true`;
`serveGuest` turns them into NDJSON responses. The annotated `params` /
`returns` strings feed the manifest, which is what hosts generate typed
bindings from. `apps/remote` is this exact shape in production trim
(graceful shutdown, snapshot state — see below).

## Java

No SDK required: `apps/remote-java` implements the protocol in plain Java
(`src/dev/machinen/*` — server, runtime, modules, state), zero dependencies,
and builds `dist/java-machine.jar` plus a `dist/java_machine.machine` bundle.
The jar is compiled on the host and remains a local process fallback for
`processDriver()`; Machinen demos use the machine bundle, where the jar is
payload inside the machine image rather than the entry consumers pass around.
The guest runtime needs Java, not `javac`, Gradle, Maven, or any
TypeScript toolchain; hosts render bindings from the manifest alone.

Implementing from scratch in another language? The checklist, with where
the Java reference does each step:

1. Serve `GET /mf-manifest.json` — `protocol: 3`, semver `version`, full
   signatures (`GuestServer.handleManifest` builds it from
   `runtime/Exposes.manifestExposes()`).
2. Dispatch `POST /mf/call` — unary JSON `{ ok, result }` / error envelopes
   with the protocol's wording (`GuestServer.handleCall` →
   `Exposes.call`); NDJSON streaming is only needed if you expose
   `stream` functions (the Java and Python references expose none).
3. Optionally implement `GET/POST /mf/state` for app-state snapshots
   (`state/MachineState.java`).
4. Add your machine as a conformance target — see
   [Conformance](#conformance) below.

## Python

`apps/remote-python` is the same protocol in Python 3: a `machinen_guest`
package using only the standard library. The same checklist maps onto it:

1. Manifest: `protocol.build_manifest()` renders `path -> fn -> signature`
   maps from `registry.Registry.manifest()`.
2. Calls: `GuestHandler.do_POST` routes `/mf/call` to
   `Registry.dispatch`, answering the protocol's envelopes (including the
   canonical 400 ParseError and 413 PayloadError).
3. State: `state.py`'s `CounterState.dehydrate` / `rehydrate` back
   `GET/POST /mf/state`.
4. Conformance: registered as the `python guest` target.

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
same assertions in the plugin's own guest tests) and asserts:

- a protocol-v3 manifest with a semver version and typed signatures
- a live health endpoint
- calls round-tripping JSON values
- typed error envelopes for unknown functions
- the `/mf-types.ts` static-artifact pattern (200 with content, or 404)
- the artifact capability gate: advertised `artifacts` must be fetchable and
  digest-true; unadvertised `/mf-image` & `/mf-snapshot` must answer 404/501
- state round-trips via `/mf/state`
- the canonical 400 ParseError for malformed and non-object bodies, with no
  body reflection and the connection staying live
- a 413 PayloadError for oversized bodies, with the guest surviving

To validate a new guest, add an entry to the `targets` array:

- a label and the image path (the process driver picks the boot command from
  the file extension)
- the expected machine name and one sample call
- the `/mf-types.ts` expectation (`200` + a content marker, or `404`)
- a runtime-availability check (so the suite skips honestly where the
  language runtime is missing)

The whole suite then runs against it.

## State (optional)

Guests that want app-state snapshot/restore under the process driver declare
the `state` capability: pass `state: { dehydrate, rehydrate }` to
`createGuestRuntime` (or implement `GET/POST /mf/state` directly).
`dehydrate()` returns the machine's warm state; `rehydrate(state)` resumes
from it. Machines run under `machinenDriver()` don't need it — whole-VM
snapshots carry the heap itself.

## Publishing artifacts (optional)

A machine can publish *itself* for pull federation, so consumers with a
`machinen+pull+http://...` entry fetch its program (or a warm snapshot) and
boot their own clone. In Node it is one option:

```ts
await serveGuest(guest, { port, imagePath: process.argv[1] });
```

This makes the manifest advertise an `artifacts` block, serves the program
at `GET /mf-image` (digest-addressed, immutable), and — when the guest also
has `state` support — serves fresh warm clones at `GET /mf-snapshot`.
`apps/remote` does exactly this. Non-Node guests implement the same three
pieces by hand; see the `artifacts`/`/mf-image`/`/mf-snapshot` sections of
[guest-protocol.md](guest-protocol.md), including the security note: anyone
who can reach the machine can take its code and dehydrated memory, so
publishing is strictly opt-in.
