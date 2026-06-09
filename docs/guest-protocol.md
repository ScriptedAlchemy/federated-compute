# Machine guest protocol (v3)

Any runtime that serves these endpoints can be a machine. The host never sees
machine source — it attaches to an address (containment: every machine is its
own repo/deployment; federation entries are the multiplexer + transport).

The protocol deliberately mirrors Module Federation's architecture: a
manifest-first contract (`mf-manifest.json` analog), semver version
negotiation (`requiredVersion` analog), and type distribution (DTS analog via
`machinen-bindgen`).

## Authentication

If the machine was deployed with a token (`MACHINEN_TOKEN` env var by
convention), every request except `/mf/health` must carry
`Authorization: Bearer <token>`. Unauthenticated requests get `401`. Guests
must bind loopback by default; only deliberate deployment exposes them
further.

## `GET /mf/health`

Liveness probe — no auth, no side effects. Used by drivers for boot-waiting
and by orchestrators (k8s probes, load balancers).

```json
{ "ok": true, "name": "java_machine" }
```

## `GET /mf-manifest.json` (alias: `GET /mf/manifest`)

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

## `POST /mf/call`

Request body (guests should cap bodies, 5 MB reference; respond `413` beyond):

```json
{ "module": "./strings", "fn": "upper", "args": ["hi"] }
```

### Unary response (HTTP 200, `application/json`)

```json
{ "ok": true, "result": "HI" }
```

```json
{ "ok": false, "error": { "message": "...", "type": "TypeError", "stack": "..." } }
```

`type` is the guest-side error class; `stack` is optional. The host surfaces
these as `GuestError` (with `remoteType` / `remoteStack`) — never retried.
Transport failures (`MachineTransportError`, including `MachineTimeoutError`)
are subject to the host's call policy: deadline, retries with backoff, circuit
breaker, crash hooks, and optional automatic restart.

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

## Operational requirements

- Bind `127.0.0.1` unless deployment explicitly exposes the machine.
- Shut down gracefully on SIGTERM (stop accepting, drain, exit).
- Keep `/mf/health` cheap and auth-free.

## Conformance

`packages/runtime-plugin/test/conformance.test.ts` runs this spec against the
Java and Python guests (booted as real processes); the Node guest is covered by
`test/guest-http.test.ts`. New guest languages should pass the same suite.
