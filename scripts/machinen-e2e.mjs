#!/usr/bin/env node
/**
 * Real Machinen validation — no mocks, no process drivers.
 *
 * Runs the repo's REAL Node guest (apps/remote/dist/index.js) inside a REAL
 * machinen microVM via @machinen/runtime, and validates the federation
 * protocol plus the boot-once-run-everywhere claim:
 *
 *   1. provision() a minimal image: debian base + node + the guest bundle
 *   2. boot() it with a host->guest port forward
 *   3. hit /mf/health and /mf-manifest.json through the forward, then make
 *      real calls (./counter increment, twice)
 *   4. vm.snapshot(), kill the VM, restore() the snapshot, and assert the
 *      counter CONTINUES from in-VM process heap (increment -> 3)
 *
 * Wall-time for boot-to-healthy and restore-to-healthy is printed.
 *
 * Exit codes:
 *   0  — full validation passed
 *   78 — machinen is not runnable in this environment (honest skip; the
 *        reason is printed as "machinen-unavailable: <reason>")
 *   1  — machinen ran but OUR validation failed (real failure)
 *
 * @machinen/runtime is resolved from MACHINEN_RUNTIME_DIR (a directory where
 * it has been npm-installed), falling back to normal resolution from this
 * repo. CI installs it into a scratch dir so the repo lockfile stays clean.
 */

import { createRequire } from 'node:module';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GUEST_BUNDLE = join(repoRoot, 'apps/remote/dist/index.js');
const GUEST_PORT = 3801;
const EXIT_UNAVAILABLE = 78;
// Modest explicit guest RAM. machinen auto-sizing can pick up to 4 GiB,
// which places the main memory region across the 32-bit MMIO gap and breaks
// boot on some x86 hosts ("Cannot find an available gap in the 32-bit address
// range"); 1 GiB is plenty for the guest and boots everywhere.
const GUEST_MEMORY_MIB = 1024;

const log = (msg) => console.log(`[machinen-e2e] ${msg}`);

function summaryLine(line) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  }
}

function unavailable(reason) {
  console.error(`machinen-unavailable: ${reason}`);
  summaryLine(`- machinen not yet runnable: ${reason}`);
  process.exit(EXIT_UNAVAILABLE);
}

function fail(reason) {
  console.error(`machinen-e2e FAILED: ${reason}`);
  summaryLine(`- machinen e2e FAILED: ${reason}`);
  process.exit(1);
}

// ---------------------------------------------------------------- preflight

if (process.platform === 'linux') {
  if (!existsSync('/dev/kvm')) {
    unavailable('/dev/kvm is absent on this host (no KVM / nested virtualization)');
  }
  try {
    accessSync('/dev/kvm', constants.R_OK | constants.W_OK);
  } catch {
    unavailable('/dev/kvm exists but is not read/writable by this user');
  }
} else if (process.platform !== 'darwin') {
  unavailable(`unsupported host platform ${process.platform}`);
}

if (!existsSync(GUEST_BUNDLE)) {
  fail(`guest bundle missing at ${GUEST_BUNDLE} — run \`pnpm --filter remote build\` first`);
}

// Some x64 guest payloads ship an arm64 /sbin/machinen-vmstate-reseed, so
// every vmstate restore dies with Exec format error
// (BOOT_VMSTATE_RESEED_FAILED, exit 126). We drop a functionally equivalent
// shell shim over it inside the source VM before snapshotting; the restored
// guest then reseeds its CSPRNG for real and the restore completes.
// (The CRIU engine is no alternative: guest criu 3.17.1 cannot restore
// node 18's OpenSSL MADV_WIPEONFORK pages.)
//
// A bare write to /dev/urandom is NOT enough: it mixes the seed into the
// input pool but does not reseed the ChaCha output crng, so two restores
// from one bundle replay identical /dev/urandom output until the kernel's
// next scheduled reseed (up to 60s). The shim therefore uses perl-base
// (Debian essential, present in every machinen rootfs) to issue the same
// ioctls the real helper would: RNDADDENTROPY (0x40085203) credits the
// host-provided seed, RNDRESEEDCRNG (0x5207) forces the crng to rekey from
// it immediately. The e2e asserts the divergence below.
// TODO: drop once upstream fixes the helper arch in @machinen/native-x64-linux.
const RESEED_SHIM = `#!/bin/sh
# x64 shim for machinen 0.4.0's mis-arched arm64 reseed helper. $1 is the
# hex seed the host runtime generates fresh for every restore.
if [ -x /usr/bin/perl ]; then
  exec /usr/bin/perl -e '
    my $seed = pack("H*", $ARGV[0]);
    open(my $fh, "+<", "/dev/urandom") or die "open /dev/urandom: $!";
    my $req = pack("l l a*", 8 * length($seed), length($seed), $seed);
    ioctl($fh, 0x40085203, $req) or die "RNDADDENTROPY: $!";
    ioctl($fh, 0x5207, 0) or die "RNDRESEEDCRNG: $!";
  ' "$1"
fi
# Fallback for images without perl: mix the seed into the input pool. The
# crng still rekeys from it at the kernel next scheduled reseed.
printf '%s' "$1" > /dev/urandom
exit 0
`;

let runtime;
try {
  const fromDir = process.env.MACHINEN_RUNTIME_DIR
    ? createRequire(join(resolve(process.env.MACHINEN_RUNTIME_DIR), 'package.json'))
    : createRequire(import.meta.url);
  const entry = fromDir.resolve('@machinen/runtime');
  runtime = await import(pathToFileURL(entry).href);
} catch (err) {
  unavailable(`@machinen/runtime could not be loaded: ${err?.message ?? err}`);
}

const {
  provision,
  boot,
  attach,
  restore,
  resolveBaseKernel,
  resolveBaseDtb,
  isMachinenError,
  formatMachinenError,
} = runtime;

// boot() does not auto-resolve the guest kernel the way provision() does;
// resolve it from the machinen asset cache (populated by `machinen install`).
let kernel;
let dtb;
try {
  kernel = resolveBaseKernel();
  dtb = resolveBaseDtb();
} catch (err) {
  unavailable(`machinen base assets missing (run \`pnpm exec machinen install\`): ${err?.message ?? err}`);
}

// Errors that mean "machinen can't run here", as opposed to "our validation
// found a real problem". Deliberately narrow: only failures that occur
// BEFORE any of this script's own fixes (explicit kernel/dtb, explicit
// memory, reseed shim) are in play may skip. Anything those fixes guard
// against must FAIL — recurrence means a workaround regressed.
//
// NOT listed (now hard failures):
//   - BOOT_KERNEL_NOT_FOUND / BOOT_DTB_NOT_FOUND and the PROVISION_*
//     kernel/dtb codes: we resolve kernel+dtb ourselves up front (missing
//     assets already exit 78 there) and pass them explicitly, so these
//     firing later means the explicit-kernel fix regressed.
const UNAVAILABLE_CODES = new Set([
  // The platform-native VMM package is absent or unloadable — install-time
  // environment problem, hit before any VM is configured.
  'BOOT_VMM_MISSING',
  'BOOT_VMM_PACKAGE_BROKEN',
  // The debian base rootfs was never fetched (`machinen install`); the
  // script does not resolve the rootfs itself, so this is genuinely
  // environmental.
  'PROVISION_BASE_NOT_FOUND',
]);

// VMM startup failures that mean the host's virtualization stack can't run
// machinen at all. Also deliberately narrow:
//
// NOT listed (now a hard failure):
//   - KvmCreateVcpuFailed: vCPU creation only fails this way when the guest
//     RAM layout collides with the KVM APIC page — exactly what the
//     explicit GUEST_MEMORY_MIB fix prevents. Seeing it again means the
//     memory workaround regressed.
const VMM_CAPABILITY_PATTERNS = [
  // Opening /dev/kvm or creating the VM fd is refused (seccomp, cgroup
  // device policy, nested-virt quirks) — happens before any guest
  // configuration of ours is applied.
  /KvmCreateVmFailed/i,
  /KvmOpenFailed/i,
  /Could not access KVM/i,
  // macOS: Hypervisor.framework refused the entitlement/VM — host policy.
  /HvfError/i,
];

function classify(err, phase) {
  const text = isMachinenError?.(err) ? formatMachinenError(err) : (err?.stack ?? String(err));
  if (err?.code && UNAVAILABLE_CODES.has(err.code)) {
    unavailable(`${err.code} during ${phase} — ${err.message}`);
  }
  const full = `${text} ${err?.message ?? ''}`;
  const hit = VMM_CAPABILITY_PATTERNS.find((p) => p.test(full));
  if (hit) {
    unavailable(`VMM cannot use this host's virtualization (${hit.source.replace(/\\/g, '')}) during ${phase}`);
  }
  fail(`${phase}: ${text}`);
}

// ------------------------------------------------------------------ helpers

async function waitForHealth(port, label, timeoutMs = 120_000) {
  const started = Date.now();
  let lastErr;
  while (Date.now() - started < timeoutMs) {
    try {
      // connection: close — keep-alive sockets must not dangle into the
      // CRIU dump.
      const res = await fetch(`http://127.0.0.1:${port}/mf/health`, {
        headers: { connection: 'close' },
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) {
        const body = await res.json();
        if (body.ok === true) return Date.now() - started;
        lastErr = new Error(`health responded but not ok: ${JSON.stringify(body)}`);
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${label}: /mf/health never became healthy in ${timeoutMs}ms (${lastErr})`);
}

async function call(port, module, fn, args = []) {
  const res = await fetch(`http://127.0.0.1:${port}/mf/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ module, fn, args }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`call ${module}#${fn} failed: ${JSON.stringify(body)}`);
  return body.result;
}

// The vsock exec agent inside a restored VM can take a beat to re-register
// with the new VMM process; probe instead of failing on the first attempt.
async function execWithRetry(vm, cmd, label, attempts = 10) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await vm.exec(cmd, { execTimeoutMs: 15_000 });
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  throw new Error(`${label}: exec never succeeded after ${attempts} attempts (${lastErr})`);
}

async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

// --------------------------------------------------------------------- run

const work = mkdtempSync(join(tmpdir(), 'machinen-e2e-'));
const imagePath = join(work, 'guest-image.tar.gz');
const snapDir = join(work, 'snapshot');
let bootVm;
let restoredVm;
let entropyVm;
const timings = {};

const cleanup = async () => {
  for (const vm of [bootVm, restoredVm, entropyVm]) {
    try {
      await vm?.kill();
    } catch {}
  }
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
};
process.on('SIGINT', () => void cleanup().then(() => process.exit(130)));

try {
  // (a) provision a minimal image: node + the REAL guest bundle.
  log(`provisioning image with node + real guest (${GUEST_BUNDLE}) ...`);
  const bundle = readFileSync(GUEST_BUNDLE);
  let t0 = Date.now();
  try {
    await provision({
      out: imagePath,
      cmd: ['node', '/opt/guest/index.mjs'],
      env: { PORT: String(GUEST_PORT), HOST: '0.0.0.0' },
      vmmEnv: { MACHINEN_MEMORY: String(GUEST_MEMORY_MIB) },
      timeoutMs: 8 * 60_000,
      install: async (vm) => {
        // The guest exec agent can come up a beat after the first vsock
        // connection attempts; probe with short timeouts instead of letting
        // a half-open first exec eat the full default 300s ceiling.
        let ready = false;
        for (let i = 0; i < 8 && !ready; i++) {
          try {
            await vm.exec('true', { execTimeoutMs: 15_000 });
            ready = true;
          } catch {
            await new Promise((r) => setTimeout(r, 1_000));
          }
        }
        if (!ready) throw new Error('guest exec agent never became ready');
        log('install: agent ready, apt-get update ...');
        await vm.exec('apt-get update', { execTimeoutMs: 120_000 });
        log('install: apt-get install nodejs ...');
        // </dev/null matters: through the vsock exec agent dpkg can block on
        // an stdin stream that never reaches EOF. iptables is required by
        // criu to lock established TCP connections during the dump.
        await vm.exec(
          'DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs ca-certificates iptables </dev/null',
          { execTimeoutMs: 240_000 },
        );
        log('install: writing guest bundle ...');
        await vm.exec('node --version', { execTimeoutMs: 30_000 });
        await vm.writeFile('/opt/guest/index.mjs', bundle, { mode: 0o644 });
        log('install: done');
      },
    });
  } catch (err) {
    classify(err, 'provision');
  }
  timings.provision_ms = Date.now() - t0;
  log(`provisioned ${imagePath} in ${timings.provision_ms}ms`);

  // (b) boot with a port forward.
  const bootPort = await freePort();
  log(`booting VM with port forward 127.0.0.1:${bootPort} -> guest:${GUEST_PORT} ...`);
  t0 = Date.now();
  try {
    bootVm = await boot({
      image: imagePath,
      name: 'federated-e2e',
      kernel,
      dtb,
      memory: GUEST_MEMORY_MIB,
      portForward: [{ hostPort: bootPort, guestPort: GUEST_PORT }],
      timeoutMs: null,
    });
  } catch (err) {
    classify(err, 'boot');
  }
  const bootHealthMs = await waitForHealth(bootPort, 'boot');
  timings.boot_to_healthy_ms = Date.now() - t0;
  log(`boot -> healthy in ${timings.boot_to_healthy_ms}ms (health poll ${bootHealthMs}ms)`);

  // (c) the real protocol, through the real VM.
  const manifest = await (
    await fetch(`http://127.0.0.1:${bootPort}/mf-manifest.json`, {
      headers: { connection: 'close' },
    })
  ).json();
  if (manifest.name !== 'compute_machine' || !manifest.exposes?.['./counter']) {
    throw new Error(`unexpected manifest: ${JSON.stringify(manifest).slice(0, 300)}`);
  }
  log(`manifest ok: ${manifest.name}@${manifest.version}, exposes ${Object.keys(manifest.exposes).join(', ')}`);

  const one = await call(bootPort, './counter', 'increment');
  const two = await call(bootPort, './counter', 'increment');
  if (one !== 1 || two !== 2) throw new Error(`counter increments wrong: got ${one}, ${two}`);
  const where = await call(bootPort, './system', 'whereAmI');
  log(`counter incremented to ${two}; guest reports node ${where.node} pid ${where.pid} (${where.platform})`);

  // (d) snapshot, kill, restore — boot once, run everywhere.
  // Patch the broken arm64 reseed helper before the snapshot so the restored
  // guest (which boots from this VM's rootdisk) can complete its reseed step.
  await bootVm.writeFile('/sbin/machinen-vmstate-reseed', RESEED_SHIM, { mode: 0o755 });

  log('snapshotting ...');
  t0 = Date.now();
  // Snapshot through an attach handle: machinen's snapshot path can
  // await errorOutput(), which on a boot-owned handle only resolves when the
  // VM exits — deadlock. Attach handles return console state immediately,
  // matching how the machinen CLI itself snapshots.
  const snapVm = await attach({ pid: bootVm.pid });
  // Outer race: never let CI sit on a wedged snapshot.
  await Promise.race([
    snapVm.snapshot({ outDir: snapDir, timeoutMs: 120_000 }),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('snapshot exceeded 180s wall-time guard')), 180_000),
    ),
  ]);
  timings.snapshot_ms = Date.now() - t0;
  log(`snapshot written to ${snapDir} in ${timings.snapshot_ms}ms`);

  log('killing source VM ...');
  await bootVm.kill().catch(() => {});
  bootVm = undefined;

  const restorePort = await freePort();
  log(`restoring with port forward 127.0.0.1:${restorePort} -> guest:${GUEST_PORT} ...`);
  t0 = Date.now();
  try {
    restoredVm = await restore({
      snapDir,
      kernel,
      dtb,
      memory: GUEST_MEMORY_MIB,
      portForward: [{ hostPort: restorePort, guestPort: GUEST_PORT }],
      timeoutMs: null,
    });
  } catch (err) {
    classify(err, 'restore');
  }
  await waitForHealth(restorePort, 'restore');
  timings.restore_to_healthy_ms = Date.now() - t0;
  log(`restore -> healthy in ${timings.restore_to_healthy_ms}ms`);

  const three = await call(restorePort, './counter', 'increment');
  if (three !== 3) {
    throw new Error(
      `counter did NOT continue across snapshot/restore: expected 3, got ${three} — in-VM heap was not preserved`,
    );
  }
  log('counter continued 2 -> 3 across snapshot/kill/restore: in-VM process heap preserved');

  // (e) entropy divergence — the property the functional reseed shim buys
  // over a bare `exit 0` stub. Two VMs restored from the SAME bundle resume
  // from identical kernel CSPRNG state; only a real reseed (the shim
  // crediting the per-restore host seed and forcing a crng rekey) makes
  // their entropy streams diverge immediately.
  const READ_ENTROPY = 'head -c 32 /dev/urandom | base64';
  const entropyA = (await execWithRetry(restoredVm, READ_ENTROPY, 'restore #1 entropy read')).stdout.trim();
  log('restoring a second VM from the same bundle for the entropy check ...');
  try {
    entropyVm = await restore({
      snapDir,
      kernel,
      dtb,
      memory: GUEST_MEMORY_MIB,
      timeoutMs: null,
    });
  } catch (err) {
    classify(err, 'second restore (entropy check)');
  }
  const entropyB = (await execWithRetry(entropyVm, READ_ENTROPY, 'restore #2 entropy read')).stdout.trim();
  if (!entropyA || !entropyB) {
    throw new Error(`entropy read came back empty (A="${entropyA}" B="${entropyB}")`);
  }
  if (entropyA === entropyB) {
    throw new Error(
      'two VMs restored from one bundle produced IDENTICAL /dev/urandom output — ' +
        'the reseed shim did not actually reseed the guest CSPRNG',
    );
  }
  log('entropy diverged across two restores from one bundle: reseed shim performs a real reseed');
  await entropyVm.kill().catch(() => {});
  entropyVm = undefined;

  const summary =
    `provision=${timings.provision_ms}ms boot_to_healthy=${timings.boot_to_healthy_ms}ms ` +
    `snapshot=${timings.snapshot_ms}ms restore_to_healthy=${timings.restore_to_healthy_ms}ms`;
  log(`PASS — real machinen VM validated our protocol end to end (${summary})`);
  summaryLine(`- real machinen validation PASSED: ${summary}`);
  await cleanup();
  process.exit(0);
} catch (err) {
  await cleanup();
  fail(err?.stack ?? String(err));
}
