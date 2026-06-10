# Real Machinen driver

`machinenDriver()` (in `@federated-compute/machinen-plugin`) boots
`machinen://` entries as **actual microVMs** through
[`@machinen/runtime`](https://www.npmjs.com/package/@machinen/runtime) — KVM
on Linux (x86_64 and arm64), HVF on Apple Silicon. Status: **working today**
on machinen 0.4.0; verified end to end on x86_64/KVM by
`packages/runtime-plugin/test/machinen-driver.test.ts` (a real-VM integration
test that skips itself honestly when `/dev/kvm` or the package is missing)
and by `pnpm demo:machinen`.

```ts
import { createMachines, machinenDriver } from '@federated-compute/machinen-plugin';

const machines = createMachines({
  driver: machinenDriver(),            // real VMs from here on
  bootTimeoutMs: 180_000,
  remotes: { compute_machine: `machinen://${bundlePath}?token=${token}` },
});
await machines.machine('compute_machine').counter.increment(); // runs inside a microVM

const snap = await machines.plugin.snapshotMachine('compute_machine'); // whole-VM vmstate bundle
// later, anywhere: an entry pointing at the bundle dir restores the VM mid-heap
// remotes: { compute_machine: `machinen://${snap.snapDir}?token=${token}` }
```

Boot model: the driver boots the machinen debian base, installs node inside
the guest over vsock exec (~5s; pass `image:` with node prebaked to skip),
`vm.writeFile`s the guest bundle plus a launcher carrying
`PORT`/`HOST`/`MACHINEN_TOKEN`, starts it, and serves all calls through a
gvproxy host→guest port forward — the handle is the same `httpMachineHandle`
the other drivers use. `handle.snapshot()` freezes the whole VM (RAM +
rootdisk + vCPU state, ~2.5GB bundle); booting a `machinen://<snapDir>` entry
restores it and the guest process resumes mid-heap. `@machinen/runtime` is an
**optional peer dependency** loaded lazily on first boot — non-VM users never
pull the ~18MB native package, and the error when it's missing says exactly
what to install.

Security note: whole-VM snapshot bundles are credential-bearing artifacts —
the rootdisk and RAM dump include the launcher token and process memory, so
treat bundles like secrets. The amd64 reseed workaround performs a *real*
reseed: the shim feeds the host-provided seed to the guest CSPRNG on restore,
so VMs restored from one bundle do not share RNG/UUID/key state.

Measured on x86_64/KVM (machinen 0.4.0, nested KVM, warm asset cache):

| phase | wall time |
| --- | --- |
| VM boot (debian base) | ~5.3s |
| apt + node install in guest | ~5–6s |
| boot → guest healthy, total | ~9.5s |
| warm federated call | ~1–2ms |
| whole-VM snapshot (2.5GB bundle) | ~7s |
| restore → guest healthy | ~5.5s |

Four amd64 0.4.0 upstream bugs were diagnosed empirically and are worked
around inside the driver (each carries a comment at the call site):

1. **Auto memory sizing crashes the VMM** — default sizing picks a guest RAM
   layout colliding with the KVM APIC page (`KvmCreateVcpuFailed` at boot).
   The driver always passes an explicit `memory` (default 2048 MiB; keep
   ≤ ~3500 on amd64).
2. **`provision()` stalls** — its in-VM exec hangs until the 300s
   `EXEC_AGENT_TIMEOUT`. The driver never calls `provision()`; boot-then-exec
   performs the same install in ~5s.
3. **Restore dies in entropy reseed** — the amd64 base rootfs ships an
   *aarch64* `/sbin/machinen-vmstate-reseed` ("Exec format error" → restore
   fails with `BOOT_VMSTATE_RESEED_FAILED`). `handle.snapshot()` replaces the
   binary with a functional shell shim before every dump: on restore it
   credits the host-provided seed to the guest CSPRNG (`RNDADDENTROPY`) and
   forces an immediate crng rekey (`RNDRESEEDCRNG`), so the guest's
   randomness is genuinely reseeded instead of frozen. The machinen e2e
   asserts the property: two VMs restored from one bundle produce different
   `/dev/urandom` output.
4. **`fork()` is unreliable on amd64** — the forked sibling does not resume
   dependably. `handle.fork()` throws a clear not-supported-on-amd64 error;
   snapshot + boot-from-bundle covers the clone-a-warm-VM use case meanwhile.

(A fifth quirk, also handled: programmatic `boot()`/`restore()` don't resolve
the kernel path the way the CLI does — without an explicit `kernel:` the VMM
exits with "MACHINEN_KERNEL is unset". The driver passes
`resolveBaseKernel()` on every boot and restore.)

`fork()` and `provision()` support are pending those upstream fixes; the
driver's semantics (and the error messages) are written so they slot in
without interface changes.

## Real Machinen validation in CI

The main CI lane uses the process driver (fast, no VM hardware needed). A
separate lane —
`.github/workflows/machinen.yml` — validates against **real Machinen**
(`@machinen/runtime`, published on npm): it provisions an image containing the
real Node guest (`apps/remote/dist/index.js`), boots it in a real microVM with
a port forward, exercises `/mf/health`, `/mf-manifest.json`, and live
`./counter` calls, then snapshots, kills, and restores the VM and asserts the
counter continues — the boot-once-run-everywhere claim, for real, with boot
and restore wall times reported.

The lane runs on both `ubuntu-24.04` (x64) and `ubuntu-24.04-arm` (arm64).
On x64, hosted runners expose `/dev/kvm` and the full validation **runs and
is enforced today** — validation failures fail the job. On arm64, hosted
runners currently have **no** `/dev/kvm` (nested virtualization isn't exposed
on Azure arm64 VMs), so that leg writes its hardware audit, reports
"machinen not yet runnable: <reason>" with `machinen_available=false`, and
exits green without faking success; it flips to enforcing automatically the
moment KVM appears there. Run the validation anywhere compatible with
`node scripts/machinen-e2e.mjs` (exit 78 = machinen unavailable, 1 =
validation failed).

Note: typical x86_64 dev boxes were the original blocker; machinen now ships
`@machinen/native-x64-linux`, so any Linux machine with usable `/dev/kvm` can
run the validation locally too.
