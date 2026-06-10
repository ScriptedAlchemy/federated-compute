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

const { provision, boot, restore, isMachinenError, formatMachinenError } = runtime;

// Errors that mean "machinen can't run here", as opposed to "our validation
// found a real problem". VMM missing/broken and unfetched base assets are
// environment problems, not protocol failures.
const UNAVAILABLE_CODES = new Set([
  'BOOT_VMM_MISSING',
  'BOOT_VMM_PACKAGE_BROKEN',
  'PROVISION_BASE_NOT_FOUND',
  'PROVISION_KERNEL_NOT_FOUND',
  'PROVISION_DTB_NOT_FOUND',
  'BOOT_KERNEL_NOT_FOUND',
  'BOOT_DTB_NOT_FOUND',
]);

// VMM startup failures that mean the host's virtualization stack can't run
// machinen at all (e.g. KVM present but vCPU creation refused). These are
// host-capability problems, not failures of OUR protocol inside the VM.
const VMM_CAPABILITY_PATTERNS = [
  /KvmCreateVmFailed/i,
  /KvmCreateVcpuFailed/i,
  /KvmOpenFailed/i,
  /Could not access KVM/i,
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
      const res = await fetch(`http://127.0.0.1:${port}/mf/health`, {
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
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ module, fn, args }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`call ${module}#${fn} failed: ${JSON.stringify(body)}`);
  return body.result;
}

const freePort = () => 20_000 + Math.floor(Math.random() * 20_000);

// --------------------------------------------------------------------- run

const work = mkdtempSync(join(tmpdir(), 'machinen-e2e-'));
const imagePath = join(work, 'guest-image.tar.gz');
const snapDir = join(work, 'snapshot');
let bootVm;
let restoredVm;
const timings = {};

const cleanup = async () => {
  for (const vm of [bootVm, restoredVm]) {
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
      timeoutMs: 8 * 60_000,
      install: async (vm) => {
        await vm.exec('apt-get update');
        await vm.exec('apt-get install -y --no-install-recommends nodejs ca-certificates');
        await vm.exec('node --version');
        await vm.writeFile('/opt/guest/index.mjs', bundle, { mode: 0o644 });
      },
    });
  } catch (err) {
    classify(err, 'provision');
  }
  timings.provision_ms = Date.now() - t0;
  log(`provisioned ${imagePath} in ${timings.provision_ms}ms`);

  // (b) boot with a port forward.
  const bootPort = freePort();
  log(`booting VM with port forward 127.0.0.1:${bootPort} -> guest:${GUEST_PORT} ...`);
  t0 = Date.now();
  try {
    bootVm = await boot({
      image: imagePath,
      name: 'federated-e2e',
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
  const manifest = await (await fetch(`http://127.0.0.1:${bootPort}/mf-manifest.json`)).json();
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
  log('snapshotting ...');
  t0 = Date.now();
  await bootVm.snapshot({ outDir: snapDir });
  timings.snapshot_ms = Date.now() - t0;
  log(`snapshot written to ${snapDir} in ${timings.snapshot_ms}ms`);

  log('killing source VM ...');
  await bootVm.kill();
  bootVm = undefined;

  const restorePort = freePort();
  log(`restoring with port forward 127.0.0.1:${restorePort} -> guest:${GUEST_PORT} ...`);
  t0 = Date.now();
  try {
    restoredVm = await restore({
      snapDir,
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
