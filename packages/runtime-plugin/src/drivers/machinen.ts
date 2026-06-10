import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile as writeHostFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { MachineDriver, MachineHandle, MachineSpec } from '../types.js';
import { httpMachineHandle } from './http.js';
import { getFreePort } from './process.js';

/**
 * The REAL Machinen driver: boots `machinen://` entries as actual microVMs
 * through `@machinen/runtime` (KVM on Linux, HVF on Apple Silicon).
 *
 * Boot model (verified against machinen 0.4.0 on x86_64/KVM):
 *   1. boot the debian base rootfs with an idle supervised cmd,
 *   2. `vm.exec` an apt-get install of node (~5s; skipped when `opts.image`
 *      ships node prebaked),
 *   3. `vm.writeFile` the guest bundle + a launcher script carrying
 *      PORT/HOST/MACHINEN_TOKEN, start it detached inside the guest,
 *   4. talk guest protocol v3 over a gvproxy host->guest port forward —
 *      the returned handle is `httpMachineHandle` against the forward.
 *
 * `handle.snapshot()` writes a whole-VM vmstate bundle (RAM + rootdisk +
 * vCPU state); booting a `machinen://<snapDir>` entry restores it and the
 * guest process resumes mid-heap.
 *
 * amd64 0.4.0 workarounds baked in (each one empirically diagnosed):
 *   - explicit `memory` always passed (default 2048 MiB): the runtime's
 *     auto-sizing collides with the KVM APIC page (KvmCreateVcpuFailed),
 *   - `provision()` is NOT used (its exec stalls until a 300s timeout);
 *     boot-then-exec installs node in ~5s instead,
 *   - `/sbin/machinen-vmstate-reseed` in the amd64 rootfs is an aarch64
 *     binary ("Exec format error" -> BOOT_VMSTATE_RESEED_FAILED on
 *     restore); snapshot() first replaces it with a functional shell shim
 *     that reseeds the guest CSPRNG from the host-provided seed,
 *   - snapshots go through an attach() handle: the CRIU engine's snapshot
 *     path awaits errorOutput(), which deadlocks on a boot-owned handle,
 *   - `fork()` is unreliable on amd64; `handle.fork()` throws a clear
 *     not-supported error until the upstream fix lands.
 */

const DEFAULT_GUEST_PORT = 3801;
const DEFAULT_MEMORY_MIB = 2048;
const DEFAULT_BOOT_TIMEOUT_MS = 120_000;
const GUEST_DIR = '/opt/federated';
const GUEST_BUNDLE = `${GUEST_DIR}/guest.mjs`;
const GUEST_LAUNCHER = `${GUEST_DIR}/run.sh`;
const GUEST_LOG = '/var/log/federated-guest.log';
const RESEED_BINARY = '/sbin/machinen-vmstate-reseed';
/**
 * Functional replacement for machinen 0.4.0's mis-arched reseed helper
 * (identical to the shim in scripts/machinen-e2e.mjs, which asserts its
 * behavior). The amd64 base rootfs ships an aarch64 binary at
 * RESEED_BINARY, so every vmstate restore dies with "Exec format error"
 * (BOOT_VMSTATE_RESEED_FAILED). A bare `exit 0` stub would unblock the
 * restore but freeze guest entropy: every VM restored from one bundle
 * would share RNG/UUID/key state. A bare write to /dev/urandom is not
 * enough either — it mixes the seed into the input pool without rekeying
 * the output crng, so restores replay identical randomness for up to 60s.
 * The shim uses perl-base (Debian essential, present in every machinen
 * rootfs) to issue the ioctls the real helper would: RNDADDENTROPY
 * credits the host seed, RNDRESEEDCRNG forces an immediate crng rekey.
 */
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
/** Written into every snapshot bundle so a restore knows the guest port. */
const SNAP_MARKER = 'federated-machine.json';
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Minimal structural types for the @machinen/runtime surface this driver
// uses. Locally declared (not `import type` from the package) so the
// emitted .d.ts never references the optional peer — consumers without
// @machinen/runtime installed must still typecheck.
interface MachinenExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface MachinenVm {
  readonly pid: number;
  readonly name?: string;
  exec(cmd: string, opts?: { execTimeoutMs?: number }): Promise<MachinenExecResult>;
  writeFile(
    guestPath: string,
    contents: Buffer | string,
    opts?: { mode?: number; recursive?: boolean },
  ): Promise<void>;
  snapshot(opts: { outDir: string; timeoutMs?: number }): Promise<{
    snapDir: string;
    elapsedMs: number;
  }>;
  kill(): Promise<void>;
}

interface MachinenRuntime {
  boot(opts: Record<string, unknown>): Promise<MachinenVm>;
  restore(opts: Record<string, unknown>): Promise<MachinenVm>;
  /** Reconnect to a live VM by VMM pid (registry lookup); used for snapshots. */
  attach(opts: { pid?: number; name?: string }): Promise<MachinenVm>;
  kill?(name: string): Promise<void> | void;
  resolveBaseRootfs(explicit?: string, cwd?: string): string;
  resolveBaseKernel(explicit?: string, cwd?: string): string;
  resolveBaseDtb(explicit?: string, cwd?: string): string | undefined;
}

/**
 * The CLI resolves kernel/dtb before spawning the VMM, but programmatic
 * `boot()`/`restore()` in 0.4.0 do not — without an explicit `kernel` the
 * VMM exits with "MACHINEN_KERNEL is unset" and exec never comes up.
 */
function baseBootAssets(runtime: MachinenRuntime): { kernel: string; dtb?: string } {
  const kernel = runtime.resolveBaseKernel();
  const dtb = runtime.resolveBaseDtb?.();
  return dtb ? { kernel, dtb } : { kernel };
}

interface SnapMarker {
  remoteName: string;
  guestPort: number;
  image: string;
  snappedAt: string;
}

export interface MachinenSnapshotDescriptor {
  /** Snapshot bundle directory — boot a `machinen://<snapDir>` entry to restore. */
  snapDir: string;
  /** Rootfs tarball the source VM booted from (recorded for cross-host moves). */
  image: string;
}

export interface MachinenDriverOptions {
  /**
   * Guest RAM ceiling in MiB. Default 2048. Always passed explicitly:
   * machinen 0.4.0's auto-sizing on amd64 picks layouts that collide with
   * the KVM APIC page (KvmCreateVcpuFailed). Keep it <= ~3500 on amd64.
   */
  memoryMib?: number;
  /** Where handle.snapshot() writes VM bundles. Default: .machinen/vm-snapshots */
  snapshotDir?: string;
  /**
   * Rootfs tarball with node prebaked. When set, the boot-time
   * `apt-get install nodejs` step is skipped. Default: the machinen
   * debian base (node installed at boot, ~5s).
   */
  image?: string;
  /** Extra env baked into the guest launcher (merged over PORT/HOST/token). */
  env?: Record<string, string>;
  /** Deadline for the guest to answer /mf/health after VM boot/restore. Default 60s. */
  guestReadyTimeoutMs?: number;
  /** Deadline for the VMM boot/restore call itself. Default 120s. */
  bootTimeoutMs?: number;
  /** Startup progress lines (one per phase). Default: process.stderr. */
  log?: (line: string) => void;
}

let runtimePromise: Promise<MachinenRuntime> | undefined;

/**
 * Lazy-load @machinen/runtime so the plugin never hard-requires the ~18MB
 * native dependency: non-VM users (httpAttachDriver/processDriver) must be
 * able to install and run this package without it. It is declared as an
 * optional peerDependency — installing it is the explicit opt-in to VMs.
 */
export async function loadRuntime(): Promise<MachinenRuntime> {
  runtimePromise ??= import('@machinen/runtime').then(
    (mod) => mod as unknown as MachinenRuntime,
    (error: unknown) => {
      runtimePromise = undefined;
      throw new Error(
        '[machinen-plugin] machinenDriver needs @machinen/runtime, which is not installed ' +
          '(it is an optional peer dependency). Install it next to this package: ' +
          '`pnpm add @machinen/runtime@0.4.0 @machinen/cli@0.4.0` then `pnpm exec machinen install` to fetch ' +
          `base assets. Underlying error: ${(error as Error)?.message ?? error}`,
      );
    },
  );
  return runtimePromise;
}

/** A machinen snapshot bundle is a directory holding meta.json (+ state.vmstate). */
export async function isMachinenSnapshotDir(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isDirectory()) return false;
    return existsSync(path.join(candidate, 'meta.json')) && existsSync(path.join(candidate, 'state.vmstate'));
  } catch {
    return false;
  }
}

export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function guestPortFor(spec: MachineSpec): number {
  return Number(spec.params.get('port')) || DEFAULT_GUEST_PORT;
}

export function resolveGuestPort(spec: MachineSpec, marker?: Pick<SnapMarker, 'guestPort'>): number {
  return marker?.guestPort ?? guestPortFor(spec);
}

function assertValidEnvKey(key: string): void {
  if (!ENV_KEY_RE.test(key)) {
    throw new Error(
      `[machinen-plugin] invalid env key "${key}": keys must match ${ENV_KEY_RE.source}`,
    );
  }
}

async function checkedExec(
  vm: MachinenVm,
  cmd: string,
  what: string,
  opts?: { execTimeoutMs?: number },
): Promise<MachinenExecResult> {
  const result = await vm.exec(cmd, opts);
  if (result.exitCode !== 0) {
    const details = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
    throw new Error(
      `[machinen-plugin] ${what} failed with exit code ${result.exitCode}` +
        (details ? `:\n${details}` : ''),
    );
  }
  return result;
}

class GuestHealthTimeoutError extends Error {}

async function withGuestLogOnHealthTimeout(vm: MachinenVm, error: unknown): Promise<Error> {
  if (!(error instanceof GuestHealthTimeoutError)) return error as Error;
  try {
    const result = await vm.exec(`tail -50 ${GUEST_LOG}`, { execTimeoutMs: 5_000 });
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    const suffix = output || `(no output; tail exited ${result.exitCode})`;
    return new Error(`${error.message}\nGuest log tail (${GUEST_LOG}):\n${suffix}`);
  } catch (tailError) {
    return new Error(
      `${error.message}\nGuest log tail (${GUEST_LOG}) unavailable: ${(tailError as Error).message}`,
    );
  }
}

async function killByNameIfSupported(runtime: MachinenRuntime, name: string): Promise<void> {
  if (typeof runtime.kill !== 'function') return;
  await runtime.kill(name);
}

async function withVmStartTimeout(
  start: Promise<MachinenVm>,
  runtime: MachinenRuntime,
  name: string,
  what: string,
  timeoutMs: number,
): Promise<MachinenVm> {
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const guardedStart = start.then(
    (vm) => {
      if (timedOut) void vm.kill().catch(() => {});
      return vm;
    },
    (error: unknown) => {
      if (!timedOut) throw error;
      return undefined;
    },
  );
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      void killByNameIfSupported(runtime, name).catch(() => {});
      reject(new Error(`[machinen-plugin] ${what} "${name}" did not complete within ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return (await Promise.race([guardedStart, timeout])) as MachinenVm;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let bootCounter = 0;

/** Registry names must be unique while live; remoteName alone could collide. */
function vmName(remoteName: string): string {
  bootCounter++;
  return `fc-${remoteName}-${process.pid}-${bootCounter}`;
}

async function waitForGuest(
  health: () => Promise<boolean>,
  what: string,
  timeoutMs: number,
): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await health()) return Date.now() - started;
    await sleep(250);
  }
  throw new GuestHealthTimeoutError(
    `[machinen-plugin] ${what}: guest did not answer /mf/health within ${timeoutMs}ms`,
  );
}

export function machinenDriver(opts: MachinenDriverOptions = {}): MachineDriver {
  const snapshotDir = opts.snapshotDir ?? path.join('.machinen', 'vm-snapshots');
  const guestReadyTimeoutMs = opts.guestReadyTimeoutMs ?? 60_000;
  const bootTimeoutMs = opts.bootTimeoutMs ?? Math.max(DEFAULT_BOOT_TIMEOUT_MS, guestReadyTimeoutMs);
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  for (const key of Object.keys(opts.env ?? {})) assertValidEnvKey(key);

  function buildHandle(
    spec: MachineSpec,
    vm: MachinenVm,
    hostPort: number,
    guestPort: number,
    image: string,
  ): MachineHandle {
    const handle = httpMachineHandle(`http://127.0.0.1:${hostPort}`, { token: spec.auth?.token });

    const snapshot = async (): Promise<MachinenSnapshotDescriptor> => {
      // amd64 0.4.0 ships an aarch64 /sbin/machinen-vmstate-reseed in the
      // debian rootfs; the restored guest runs it and dies with
      // BOOT_VMSTATE_RESEED_FAILED ("Exec format error"). Overwrite it with
      // the functional shell shim before every snapshot so the state we
      // freeze contains a helper that actually reseeds the guest CSPRNG
      // from the host-provided seed on restore.
      await vm.writeFile(RESEED_BINARY, RESEED_SHIM, { mode: 0o755 });

      await mkdir(snapshotDir, { recursive: true });
      const outDir = path.resolve(snapshotDir, `${spec.remoteName}-${Date.now().toString(36)}`);
      const started = Date.now();
      // Snapshot through an attach() handle, never the boot-owned `vm`.
      // The default vmstate engine is safe either way, but with
      // MACHINEN_SNAPSHOT_ENGINE=criu (host env, outside our control) the
      // CRIU snapshot path awaits ctx.errorOutput(), which on a boot-owned
      // handle is a collect(child.stderr) promise that only resolves when
      // the VM exits — a guaranteed deadlock. Attach handles resolve
      // errorOutput() immediately (this is also how the machinen CLI
      // snapshots), so the same driver code is safe under every engine.
      const runtime = await loadRuntime();
      const snapVm = await runtime.attach({ pid: vm.pid });
      await snapVm.snapshot({ outDir });
      const marker: SnapMarker = {
        remoteName: spec.remoteName,
        guestPort,
        image,
        snappedAt: new Date().toISOString(),
      };
      await writeHostFile(path.join(outDir, SNAP_MARKER), JSON.stringify(marker, null, 2));
      log(`[machinen] ${spec.remoteName}: snapshot -> ${outDir} (${Date.now() - started}ms)`);
      return { snapDir: outDir, image };
    };

    const fork = async (): Promise<never> => {
      throw new Error(
        '[machinen-plugin] machinenDriver: fork() is not supported on amd64 with machinen 0.4.0 ' +
          '(upstream bug: the forked sibling does not resume reliably on x86_64/KVM). ' +
          'Use handle.snapshot() and boot a machinen://<snapDir> entry instead; ' +
          'fork support returns when the upstream fix ships.',
      );
    };

    return {
      ...handle,
      snapshot,
      fork,
      dispose: async () => {
        await vm.kill();
      },
    };
  }

  async function bootFresh(spec: MachineSpec, bundlePath: string): Promise<MachineHandle> {
    const runtime = await loadRuntime();
    const bundle = await readFile(bundlePath);
    const image = opts.image ?? runtime.resolveBaseRootfs();
    const guestPort = guestPortFor(spec);
    const hostPort = await getFreePort();
    const memory = Number(spec.params.get('memory')) || opts.memoryMib || DEFAULT_MEMORY_MIB;
    const name = vmName(spec.remoteName);

    const t0 = Date.now();
    log(`[machinen] ${spec.remoteName}: booting VM "${name}" (${memory} MiB, 127.0.0.1:${hostPort} -> guest:${guestPort})`);
    const vm = await withVmStartTimeout(
      runtime.boot({
        image,
        ...baseBootAssets(runtime),
        // The supervised cmd just keeps PID 1's workload alive; the actual
        // guest server is started via exec below so the same base image works
        // before node is installed. Whole-VM snapshots capture it regardless.
        cmd: ['/bin/sh', '-c', 'exec sleep infinity'],
        name,
        // Explicit memory always (amd64 KVM APIC-page collision in auto-sizing).
        memory,
        portForward: [{ hostPort, guestPort }],
        timeoutMs: bootTimeoutMs,
      }),
      runtime,
      name,
      'boot',
      bootTimeoutMs,
    );

    try {
      const booted = Date.now();
      if (!opts.image) {
        // provision() stalls on amd64 0.4.0 (vsock exec inside provision
        // times out at 300s); boot-then-exec does the same install in ~5s.
        await checkedExec(
          vm,
          'apt-get update && apt-get install -y --no-install-recommends nodejs ca-certificates',
          'install node in guest',
          { execTimeoutMs: 240_000 },
        );
        log(`[machinen] ${spec.remoteName}: node installed in guest (${Date.now() - booted}ms)`);
      }

      await vm.writeFile(GUEST_BUNDLE, bundle);
      const env: Record<string, string> = {
        HOST: '0.0.0.0', // gvproxy forwards arrive over the guest NIC, not loopback
        PORT: String(guestPort),
        ...(spec.auth?.token ? { MACHINEN_TOKEN: spec.auth.token } : {}),
        ...(opts.env ?? {}),
      };
      for (const key of Object.keys(env)) assertValidEnvKey(key);
      const launcher = [
        '#!/bin/sh',
        ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
        `exec node ${GUEST_BUNDLE} >>/var/log/federated-guest.log 2>&1`,
        '',
      ].join('\n');
      await vm.writeFile(GUEST_LAUNCHER, launcher, { mode: 0o600 });
      await checkedExec(
        vm,
        `nohup /bin/sh ${GUEST_LAUNCHER} >/dev/null 2>&1 & sleep 0.2; true`,
        'start guest launcher',
      );

      const handle = buildHandle(spec, vm, hostPort, guestPort, image);
      const readyMs = await waitForGuest(
        () => handle.health?.() ?? Promise.resolve(false),
        `boot of "${spec.remoteName}"`,
        guestReadyTimeoutMs,
      );
      log(`[machinen] ${spec.remoteName}: guest healthy ${readyMs}ms after start (${Date.now() - t0}ms total)`);
      return handle;
    } catch (error) {
      const enriched = await withGuestLogOnHealthTimeout(vm, error);
      await vm.kill().catch(() => {});
      throw enriched;
    }
  }

  async function bootFromSnapshot(spec: MachineSpec, snapDir: string): Promise<MachineHandle> {
    const runtime = await loadRuntime();
    let marker: SnapMarker | undefined;
    try {
      marker = JSON.parse(await readFile(path.join(snapDir, SNAP_MARKER), 'utf8')) as SnapMarker;
    } catch {
      // Bundle produced outside this driver — fall back to entry params.
    }
    const guestPort = resolveGuestPort(spec, marker);
    const hostPort = await getFreePort();
    const name = vmName(spec.remoteName);

    const t0 = Date.now();
    log(`[machinen] ${spec.remoteName}: restoring VM "${name}" from ${snapDir} (127.0.0.1:${hostPort} -> guest:${guestPort})`);
    // No explicit memory here: the vmstate bundle dictates the guest RAM
    // topology and a mismatched override is refused at restore.
    const vm = await withVmStartTimeout(
      runtime.restore({
        snapDir,
        ...baseBootAssets(runtime),
        name,
        portForward: [{ hostPort, guestPort }],
        timeoutMs: bootTimeoutMs,
      }),
      runtime,
      name,
      'restore',
      bootTimeoutMs,
    );

    try {
      const handle = buildHandle(spec, vm, hostPort, guestPort, marker?.image ?? snapDir);
      const readyMs = await waitForGuest(
        () => handle.health?.() ?? Promise.resolve(false),
        `restore of "${spec.remoteName}"`,
        guestReadyTimeoutMs,
      );
      log(`[machinen] ${spec.remoteName}: restored guest healthy in ${Date.now() - t0}ms (poll ${readyMs}ms)`);
      return handle;
    } catch (error) {
      const enriched = await withGuestLogOnHealthTimeout(vm, error);
      await vm.kill().catch(() => {});
      throw enriched;
    }
  }

  return {
    async boot(spec) {
      if (spec.kind !== 'image' || !spec.image) {
        throw new Error(
          `[machinen-plugin] machinenDriver expects a machinen://<image> entry, got "${spec.entry}"`,
        );
      }
      if (await isMachinenSnapshotDir(spec.image)) {
        return bootFromSnapshot(spec, spec.image);
      }
      if (/\.(mjs|js)$/.test(spec.image)) {
        return bootFresh(spec, spec.image);
      }
      throw new Error(
        `[machinen-plugin] machinenDriver cannot boot "${spec.image}": expected a .js/.mjs ` +
          'guest bundle (run inside the machinen base image) or a machinen snapshot bundle directory',
      );
    },
  };
}
