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
 *     restore); snapshot() stubs it with `exit 0` first,
 *   - `fork()` is unreliable on amd64; `handle.fork()` throws a clear
 *     not-supported error until the upstream fix lands.
 */

const DEFAULT_GUEST_PORT = 3801;
const DEFAULT_MEMORY_MIB = 2048;
const GUEST_DIR = '/opt/federated';
const GUEST_BUNDLE = `${GUEST_DIR}/guest.mjs`;
const GUEST_LAUNCHER = `${GUEST_DIR}/run.sh`;
const RESEED_BINARY = '/sbin/machinen-vmstate-reseed';
/** Written into every snapshot bundle so a restore knows the guest port. */
const SNAP_MARKER = 'federated-machine.json';

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
async function loadRuntime(): Promise<MachinenRuntime> {
  runtimePromise ??= import('@machinen/runtime').then(
    (mod) => mod as unknown as MachinenRuntime,
    (error: unknown) => {
      runtimePromise = undefined;
      throw new Error(
        '[machinen-plugin] machinenDriver needs @machinen/runtime, which is not installed ' +
          '(it is an optional peer dependency). Install it next to this package: ' +
          '`npm i @machinen/runtime @machinen/cli` then `npx machinen install` to fetch ' +
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
    return existsSync(path.join(candidate, 'meta.json'));
  } catch {
    return false;
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
  throw new Error(`[machinen-plugin] ${what}: guest did not answer /mf/health within ${timeoutMs}ms`);
}

export function machinenDriver(opts: MachinenDriverOptions = {}): MachineDriver {
  const snapshotDir = opts.snapshotDir ?? path.join('.machinen', 'vm-snapshots');
  const guestReadyTimeoutMs = opts.guestReadyTimeoutMs ?? 60_000;
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  function buildHandle(spec: MachineSpec, vm: MachinenVm, hostPort: number, image: string): MachineHandle {
    const guestPort = guestPortFor(spec);
    const handle = httpMachineHandle(`http://127.0.0.1:${hostPort}`, { token: spec.auth?.token });

    const snapshot = async (): Promise<MachinenSnapshotDescriptor> => {
      // amd64 0.4.0 ships an aarch64 /sbin/machinen-vmstate-reseed in the
      // debian rootfs; the restored guest runs it and dies with
      // BOOT_VMSTATE_RESEED_FAILED ("Exec format error"). Stub it before
      // every snapshot so the state we freeze contains a working no-op.
      await vm.writeFile(RESEED_BINARY, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await vm.exec(`chmod +x ${RESEED_BINARY}`);

      await mkdir(snapshotDir, { recursive: true });
      const outDir = path.resolve(snapshotDir, `${spec.remoteName}-${Date.now().toString(36)}`);
      const started = Date.now();
      await vm.snapshot({ outDir });
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

  function guestPortFor(spec: MachineSpec): number {
    return Number(spec.params.get('port')) || DEFAULT_GUEST_PORT;
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
    const vm = await runtime.boot({
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
      timeoutMs: null,
    });

    try {
      const booted = Date.now();
      if (!opts.image) {
        // provision() stalls on amd64 0.4.0 (vsock exec inside provision
        // times out at 300s); boot-then-exec does the same install in ~5s.
        await vm.exec('apt-get update && apt-get install -y --no-install-recommends nodejs ca-certificates', {
          execTimeoutMs: 240_000,
        });
        log(`[machinen] ${spec.remoteName}: node installed in guest (${Date.now() - booted}ms)`);
      }

      await vm.writeFile(GUEST_BUNDLE, bundle);
      const env: Record<string, string> = {
        HOST: '0.0.0.0', // gvproxy forwards arrive over the guest NIC, not loopback
        PORT: String(guestPort),
        ...(spec.auth?.token ? { MACHINEN_TOKEN: spec.auth.token } : {}),
        ...(opts.env ?? {}),
      };
      const launcher = [
        '#!/bin/sh',
        ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
        `exec node ${GUEST_BUNDLE} >>/var/log/federated-guest.log 2>&1`,
        '',
      ].join('\n');
      await vm.writeFile(GUEST_LAUNCHER, launcher, { mode: 0o755 });
      await vm.exec(`chmod +x ${GUEST_LAUNCHER} && nohup ${GUEST_LAUNCHER} >/dev/null 2>&1 & sleep 0.2; true`);

      const handle = buildHandle(spec, vm, hostPort, image);
      const readyMs = await waitForGuest(
        () => handle.health?.() ?? Promise.resolve(false),
        `boot of "${spec.remoteName}"`,
        guestReadyTimeoutMs,
      );
      log(`[machinen] ${spec.remoteName}: guest healthy ${readyMs}ms after start (${Date.now() - t0}ms total)`);
      return handle;
    } catch (error) {
      await vm.kill().catch(() => {});
      throw error;
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
    const guestPort = marker?.guestPort ?? guestPortFor(spec);
    const hostPort = await getFreePort();
    const name = vmName(spec.remoteName);

    const t0 = Date.now();
    log(`[machinen] ${spec.remoteName}: restoring VM "${name}" from ${snapDir} (127.0.0.1:${hostPort} -> guest:${guestPort})`);
    // No explicit memory here: the vmstate bundle dictates the guest RAM
    // topology and a mismatched override is refused at restore.
    const vm = await runtime.restore({
      snapDir,
      ...baseBootAssets(runtime),
      name,
      portForward: [{ hostPort, guestPort }],
      timeoutMs: null,
    });

    try {
      const handle = buildHandle(spec, vm, hostPort, marker?.image ?? snapDir);
      const readyMs = await waitForGuest(
        () => handle.health?.() ?? Promise.resolve(false),
        `restore of "${spec.remoteName}"`,
        guestReadyTimeoutMs,
      );
      log(`[machinen] ${spec.remoteName}: restored guest healthy in ${Date.now() - t0}ms (poll ${readyMs}ms)`);
      return handle;
    } catch (error) {
      await vm.kill().catch(() => {});
      throw error;
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
