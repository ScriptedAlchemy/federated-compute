# Machine guest protocol (v2)

Any runtime that serves these two endpoints can be a machine. The host never
sees machine source — it attaches to an address (containment: every machine is
its own repo/deployment; federation entries are the multiplexer + transport).

## Authentication

If the machine was booted/deployed with a token (`MACHINEN_TOKEN` env var by
convention), every request must carry `Authorization: Bearer <token>`.
Unauthenticated requests get `401`. Guests must bind loopback by default; only
deliberate deployment exposes them further.

## `GET /mf/manifest`

```json
{
  "name": "java_machine",
  "protocol": 2,
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

- `exposes` mirrors Module Federation's expose map; values are typed function
  signatures. `params[].type` and `returns` are TypeScript type expressions —
  they feed bindgen (`pnpm bindgen`) which generates host-side interfaces.
- `stream: true` marks a function whose result is a stream of `returns` chunks.

## `POST /mf/call`

Request body:

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
these as `GuestError` (with `remoteType` / `remoteStack`), distinct from
`MachineTransportError` (machine unreachable), which triggers crash hooks and
optional automatic restart.

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

## Conformance

`packages/runtime-plugin/test/conformance.test.ts` runs this spec against the
Java and Python guests (booted as real processes); the Node guest is covered by
`test/guest-http.test.ts`. New guest languages should pass the same suite.
