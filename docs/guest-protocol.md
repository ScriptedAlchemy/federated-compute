# Machine guest protocol (v3)

Any runtime that serves these endpoints can be a machine. The host never sees
machine source — it attaches to an address (containment: every machine is its
own repo/deployment; federation entries are the multiplexer + transport).

The protocol deliberately mirrors Module Federation's architecture: a
manifest-first contract (`mf-manifest.json` analog), semver version
negotiation (`requiredVersion` analog), and type distribution (DTS analog via
`machinen-bindgen`).

The protocol has no authentication: machines serve every endpoint
unauthenticated. Guests must bind loopback by default; only deliberate
deployment exposes them further.

## `GET /mf/health`

Liveness probe — no side effects. Used by drivers for boot-waiting
and by orchestrators (k8s probes, load balancers).

```json
{ "ok": true, "name": "java_machine" }
```

## `GET /mf-manifest.json`

```json
{
  "name": "java_machine",
  "protocol": 3,
  "version": "1.0.0",
  "metaData": {
    "runtime": "OpenJDK 21.0.11",
    "features": []
  },
  "exposes": {
    "./strings": {
      "upper": {
        "params": [{ "name": "s", "type": "string" }],
        "returns": "string"
      },
      "tail": {
        "params": [{ "name": "lines", "type": "number" }],
        "returns": "string",
        "stream": true
      }
    }
  }
}
```

- `version` is the semver version of the machine's API surface. Hosts may pin
  a range in the entry (`machinen+http://...?version=^1.0.0`); the plugin
  rejects mismatches with `MachineVersionError` — MF `requiredVersion`
  semantics for machines.
- `exposes` mirrors Module Federation's expose map; values are typed function
  signatures. `params[].type` and `returns` are TypeScript type expressions —
  they feed `machinen-bindgen`, which generates host-side interfaces.
- `stream: true` marks a function whose result is a stream of `returns` chunks.

### Naming

Expose paths must be `./` followed by a valid JS identifier (`./math`, not
`./word-count`), and function names must be valid JS identifiers. This keeps
host-side property access (`machine.math.add`) and generated binding exports
consistent across languages; guest runtimes reject invalid names at
construction time.

## `GET /mf-types.ts` (optional, recommended)

Type distribution, MF's `@mf-types` analog: the machine publishes its own
ready-to-import TypeScript bindings next to its manifest. For non-TS guests
this is a **static artifact**: the machine's own build/CI boots the guest,
runs `machinen-bindgen` against it, and ships the output with the deploy —
the guest then serves that file as-is. The Java reference guest serves the
file named by `MACHINEN_TYPES_FILE` (default `mf-types.ts` in its working
directory), and its `build.mjs` publishes `dist/mf-types.ts` this way; the
Python guest serves `mf-types.ts` beside `main.py` when present (its CI
would run `machinen-bindgen` to produce it — none is committed here, so it
answers 404). The Node guest has the generator in-process and renders the
artifact on the fly. Machines without the artifact answer 404 and stay fully
supported: consumers' bindgen (`machinen-bindgen`, `fetchBindingsSource`)
falls back to rendering bindings from the manifest, which carries complete
signatures. Either way the artifact is downloaded from the deployed
machine's URL — never read from its source tree.

## `GET /mf/state` and `POST /mf/state` (optional capability)

Machines that can capture warm state advertise `"state"` in
`metaData.features` and implement:

- `GET /mf/state` → `{ "ok": true, "state": <opaque JSON> }` — dehydrate the
  machine's application state.
- `POST /mf/state` with `{ "state": <opaque JSON> }` → rehydrate; the machine
  resumes from that state. Malformed bodies follow the same rules as
  `POST /mf/call` (see "Malformed and oversized requests"); rehydration
  failures answer `200` with the `{ "ok": false }` error envelope.

Machines without the capability respond `501`. This powers the process
driver's snapshot/restore — the app-state flavor of Machinen's "boot once,
run everywhere": `handle.snapshot()` writes a `.snap` bundle (state + image
reference, like Machinen bundles remembering their rootfs tarball), and
booting an entry whose image is a `.snap` restores instead of cold-booting.
Machinen-backed machines (`machinenDriver()`) do not need these endpoints:
the driver snapshots the entire microVM — memory, open files, timers — so
the guest needs no state cooperation at all. `/mf/state` remains the
protocol for process-driver snapshots.

## `POST /mf/call`

Request body (guests should cap bodies, 5 MB reference; respond `413` beyond):

```json
{ "module": "./strings", "fn": "upper", "args": ["hi"] }
```

### Malformed and oversized requests

A body that does not parse as JSON — or parses to anything other than a JSON
object — gets HTTP `400` with the canonical envelope:

```json
{ "ok": false, "error": { "message": "malformed request body", "type": "ParseError" } }
```

The message is deliberately constant: guests must never echo any part of the
body back. Parser resource limits surface the same way (the Java reference
guest rejects nesting beyond 256 levels as a `400` parse error). The
connection stays usable — guests must answer, not drop the socket, and
`/mf/health` must stay live regardless of what `/mf/call` is fed.

Bodies past the size cap get `413` with
`{ "ok": false, "error": { "message": "payload too large", "type": "PayloadError" } }`;
the guest drains the remaining upload so the client can read the response,
and closes the connection (`Connection: close`) since a half-read request
socket cannot be reused. Hosts surface both as non-retriable
`MachineRequestError`s (see "Status classification").

Within a well-formed object body, wrong field values (unknown module, missing
function, bad argument types) are guest-side dispatch errors: HTTP `200` with
the `{ "ok": false }` error envelope below.

### Unary response (HTTP 200, `application/json`)

```json
{ "ok": true, "result": "HI" }
```

```json
{ "ok": false, "error": { "message": "...", "type": "TypeError", "stack": "..." } }
```

`type` is the guest-side error class; `stack` is optional and off by default
in the reference guest — stacks reveal file paths and internals, so serving
them is opt-in (`ServeGuestOptions.exposeStacks`). The host surfaces these as
`GuestError` (with `remoteType` / `remoteStack`) — never retried.
Transport failures (`MachineTransportError`, including `MachineTimeoutError`)
are subject to the host's call policy: deadline, retries with backoff, circuit
breaker, crash hooks, and optional automatic restart.

### Status classification

A 4xx status is a deliberate answer from a live guest, not a transport
failure. Hosts must not retry, restart, or crash-account it:

- 4xx (e.g. `413` payload too large) → `MachineRequestError` carrying
  the status.
- Only 5xx and network-level errors (connection refused/reset, timeouts) are
  transport failures and flow through the retry/breaker/restart policy.

### Streaming response (`application/x-ndjson`)

One JSON object per line:

```
{"chunk": 3}
{"chunk": 2}
{"chunk": 1}
{"done": true}
```

A guest-side failure mid-stream emits `{"error": {"message": "...", "type": "..."}}`
and ends the stream.

The terminator is mandatory: every stream must end with a `done` or `error`
line. Hosts treat a body that ends without one as a truncated response —
a `MachineTransportError` — since a cut connection is otherwise
indistinguishable from a complete stream.

### Call policy for streams

Streams share the per-machine circuit breaker with unary calls, with reduced
scope:

- An **open circuit fails the stream fast at start** (`MachineCircuitOpenError`),
  before the machine is contacted.
- A transport failure at any point (start or mid-stream, including a missing
  `done` marker) **counts toward the circuit breaker** and triggers the same
  crash bookkeeping (`onMachineCrash`, machine eviction) as unary calls.
- There is **no mid-stream retry, deadline, or automatic restart**: chunks
  already yielded cannot be un-consumed, so replaying a stream is not safe for
  the host to decide. The error propagates to the consumer, who re-invokes if
  the operation is idempotent. (`restartOnCrash` applies only to unary calls.)

## Operational requirements

- Bind `127.0.0.1` unless deployment explicitly exposes the machine.
- Shut down gracefully on SIGTERM (stop accepting, drain, exit).
- Keep `/mf/health` cheap.

## Conformance

`packages/runtime-plugin/test/conformance.test.ts` runs this spec against the
Java and Python guests (booted as real processes), including the malformed-
and oversized-request rules above; the Node guest is covered by
`test/guest-http.test.ts`. Streaming — NDJSON framing and the mandatory
`done`/`error` terminator — is exercised against the Node guest, the only
reference guest that streams today; any guest that adds `stream: true`
exposes must terminate every stream the same way. New guest languages should
pass the same suite.
