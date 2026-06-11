# Design: machinen.config.json, zero-arg bindgen, and docs split

Date: 2026-06-10
Status: approved

## Goal

Make federated-compute easier for end users to consume, without publishing any
packages. Two workstreams:

1. A single per-consumer config file that drives both the runtime client and
   bindgen, replacing scattered env vars, inline options, and wrapper scripts.
2. Split the 400-line README into a slim quickstart plus focused docs, and add
   the missing guest-authoring guide.

Out of scope: publishing to npm/PyPI/Maven, an umbrella `machinen` CLI
(`dev`/`doctor`/`new`), starter templates.

## 1. `machinen.config.json`

One config file per consumer app (this repo: `apps/host/machinen.config.json`).
Format is JSON — universally parseable by the CLI, the runtime, and non-Node
tooling; no code execution to read it.

```json
{
  "machines": {
    "compute_machine": { "url": "machinen+http://127.0.0.1:3801", "version": "^1.0.0" },
    "java_machine":    { "url": "machinen+http://127.0.0.1:3802", "version": "^1.0.0" }
  },
  "bindgen": { "outDir": "src/generated" }
}
```

Schema:

- `machines` (required): map of remote name to `{ url: string, version?: string }`.
  `url` accepts the same entry forms as today (`machinen+http://...`,
  `machinen://...`).
- `bindgen.outDir` (optional, default `src/generated`): binding output
  directory, relative to the config file.

### Loader

New `loadMachinenConfig(startDir?)` exported from
`@federated-compute/machinen-plugin` (and `/client`):

- Resolves the nearest `machinen.config.json` by walking up from `startDir`
  (default `process.cwd()`).
- Sync fs read + validation. Errors name the offending file and key
  (e.g. `machinen.config.json: machines.compute_machine.url must be a string`).
- Returns `{ path, dir, machines, bindgen }` or `undefined` when no config
  exists (callers decide whether that is an error).

### Runtime integration

`createMachines()` becomes usable with zero args. Remote resolution precedence
per machine name:

1. explicit `options.remotes` / `options.versions`
2. `MACHINEN_REMOTE_<NAME>` env var (unchanged semantics — this is how prod
   overrides dev defaults)
3. `machinen.config.json` `machines` entry

`version` from the config feeds the same pinning path as `options.versions`
today. Everything else (`driver`, `calls`, `token`, etc.) keeps its current
defaults; the config file does not configure drivers or call policy.

## 2. Zero-arg bindgen

`machinen-bindgen` CLI grows two modes alongside the existing
`--url/--out` single-machine mode (kept for ad-hoc use):

- **No args**: locate the config (walk up from cwd), fetch all machine
  manifests in parallel, write one binding file per machine into
  `bindgen.outDir`, plus an `index.ts` barrel re-exporting every machine's
  modules namespaced by machine name, so consumers write
  `import { math } from './generated'` (or
  `import { compute_machine } from './generated'` when names collide —
  the barrel re-exports each machine as a namespace and additionally
  re-exports module bindings flat only when unambiguous).
- **`--check`**: regenerate in memory, diff against the files on disk, print a
  per-file drift summary and exit non-zero on any difference. Zero writes.
  This is the CI contract-enforcement mode.

Failure behavior in no-arg mode: an unreachable machine fails that machine's
file with a clear error and a non-zero exit, but still reports status for all
machines (no fail-fast on the first one).

Repo updates:

- `scripts/bindgen.mjs` becomes a thin wrapper that runs the CLI from
  `apps/host` (or is deleted if the root `pnpm bindgen` script can call it
  directly with a working directory).
- `apps/host` gains `machinen.config.json`; its imports switch to the barrel.

## 3. Docs split

Content is moved, not dropped; light editing for flow only.

- `README.md` → ~80 lines: pitch, the "it's just imports" snippet, quickstart
  (install, test, demo, bindgen, the new config file), layout table, status
  line, links to the docs below.
- `docs/operators.md` → `createMachines` options reference, hooks table, call
  policy (timeouts/retries/circuit breaker), metrics, snapshot/fork, the
  raw-MF-runtime usage, the MF-concept mapping table.
- `docs/machinen-driver.md` → the Real Machinen driver section: boot model,
  perf table, security note, the five upstream 0.4.0 quirks, the CI
  validation lane.
- `docs/writing-a-machine.md` → new: how to author a guest in Node, Java, and
  Python — protocol summary, pointers to `apps/remote`, `apps/remote-java`,
  `apps/remote-python` as reference implementations, manifest/typing
  expectations, conformance suite usage. Links to `docs/guest-protocol.md`
  for the wire contract.
- `docs/guest-protocol.md` → unchanged.

## Error handling

- Missing config where one is required (no-arg bindgen): error names the
  expected filename and search root.
- Unresolvable remote at runtime: error message includes the computed
  `MACHINEN_REMOTE_<NAME>` key, the config path searched, and an example value.
- Config validation errors name file + key + expected type.

## Testing

- Unit tests for `loadMachinenConfig`: discovery (walk-up), validation
  errors, absent-config behavior.
- Unit tests for `createMachines` resolution precedence
  (options > env > config) using a temp dir config.
- Bindgen no-arg + barrel generation tested against the in-process guest,
  mirroring the existing bindgen tests; `--check` tested for both clean and
  drifted states.
- Existing demos and the cross-language conformance suite remain the
  regression check; CI gains a `machinen-bindgen --check` step for the host.
