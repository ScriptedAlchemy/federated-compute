import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile as writeHostFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { MachineDriver, MachineHandle, MachineSpec } from '../types.js';
import {
  formatShell,
  isVmstateShellIdentity,
  sameShell,
  sha256File,
  type VmstateShellIdentity,
} from '../vmstate.js';
import { httpMachineHandle } from './http.js';
import { getFreePort } from './process.js';

/**
 * Machinen driver: boots `machinen://` entries as actual microVMs
 * through `@machinen/runtime` (KVM on Linux, HVF on Apple Silicon).
 *
 * Boot model (verified against machinen 0.6.1 on x86_64/KVM):
 *   1. boot the debian base rootfs with an idle supervised cmd,
 *   2. for lightweight guest bundles, `vm.exec` installs the needed runtime
 *      unless `opts.image` already ships it,
 *   3. `vm.writeFile` the guest program payload + a launcher script carrying
 *      PORT/HOST, then starts it detached inside the guest,
 *   4. talk guest protocol v3 over a gvproxy host->guest port forward —
 *      the returned handle is `httpMachineHandle` against the forward.
 *
 * `handle.snapshot()` writes a whole-VM vmstate bundle (RAM + rootdisk +
 * vCPU state); booting a `machinen://<snapDir>` entry restores it and the
 * guest process resumes mid-heap.
 *
 * Current x86_64/KVM runtime workarounds:
 *   - explicit `memory` always passed (default 2048 MiB): the runtime's
 *     auto-sizing collides with the KVM APIC page (KvmCreateVcpuFailed),
 *   - `provision()` is NOT used (its exec stalls until a 300s timeout);
 *     boot-then-exec installs the guest runtime in ~5s instead,
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
const DEFAULT_JAVA_ROOT_DISK_BYTES = 4 * 1024 ** 3;
const DEFAULT_BOOT_TIMEOUT_MS = 120_000;
const DEFAULT_ASSET_PROVISION_TIMEOUT_MS = 10 * 60_000;
const ASSET_PROVISION_OUTPUT_MAX_BYTES = 64 * 1024;
const GUEST_DIR = '/opt/federated';
const NODE_GUEST_BUNDLE = `${GUEST_DIR}/guest.mjs`;
const JAVA_GUEST_BUNDLE = `${GUEST_DIR}/guest.jar`;
const JAVA_TYPES_FILE = `${GUEST_DIR}/mf-types.ts`;
const GUEST_LAUNCHER = `${GUEST_DIR}/run.sh`;
const GUEST_LOG = '/var/log/federated-guest.log';
const RESEED_BINARY = '/sbin/machinen-vmstate-reseed';
const MACHINE_IMAGE_MANIFEST = 'machinen-machine.json';
/**
 * Functional replacement for the x86_64 rootfs' mis-arched reseed helper
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
# x64 shim for the mis-arched arm64 reseed helper. $1 is the
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

interface BaseBootBundle {
  image: string;
  assets: { kernel: string; dtb?: string };
}

export interface MachinenBaseAssetProvisionContext {
  timeoutMs: number;
  log: (line: string) => void;
}

export type MachinenBaseAssetProvisioner = (
  context: MachinenBaseAssetProvisionContext,
) => Promise<void> | void;

/**
 * The CLI resolves kernel/dtb before spawning the VMM, but programmatic
 * `boot()`/`restore()` do not — without an explicit `kernel` the
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
  shell: VmstateShellIdentity;
  snappedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSnapMarker(value: unknown): value is SnapMarker {
  return (
    isRecord(value) &&
    typeof value.remoteName === 'string' &&
    typeof value.guestPort === 'number' &&
    Number.isInteger(value.guestPort) &&
    value.guestPort >= 1 &&
    value.guestPort <= 65_535 &&
    typeof value.image === 'string' &&
    isVmstateShellIdentity(value.shell) &&
    typeof value.snappedAt === 'string'
  );
}

export interface MachinenSnapshotDescriptor {
  /** Snapshot bundle directory — boot a `machinen://<snapDir>` entry to restore. */
  snapDir: string;
  /**
   * Rootfs tarball the source VM booted from. Provenance only: restores
   * derive the local shell from this host's own assets and never read the
   * recorded path (it may not exist off the producer host).
   */
  image: string;
  /** Digest identity of the MachineN shell that produced the vmstate. */
  shell: VmstateShellIdentity;
}

export interface MachinenDriverOptions {
  /**
   * Guest RAM ceiling in MiB. Default 2048. Always passed explicitly:
   * MachineN auto-sizing on amd64 picks layouts that collide with
   * the KVM APIC page (KvmCreateVcpuFailed). Keep it <= ~3500 on amd64.
   */
  memoryMib?: number;
  /** Where handle.snapshot() writes VM bundles. Default: .machinen/vm-snapshots */
  snapshotDir?: string;
  /**
   * Sparse guest root disk size in bytes. The machinen runtime default is
   * used except for Java machine bundles, which default to 4 GiB so Debian's
   * JRE packages have room to unpack.
   */
  rootDiskSizeBytes?: number;
  /**
   * Rootfs tarball with the needed guest runtime prebaked. When set, the
   * boot-time apt install is skipped. Default: the machinen debian base.
   */
  image?: string;
  /** Extra env baked into the guest launcher (merged over PORT/HOST). */
  env?: Record<string, string>;
  /** Deadline for the guest to answer /mf/health after VM boot/restore. Default 60s. */
  guestReadyTimeoutMs?: number;
  /** Deadline for the VMM boot/restore call itself. Default 120s. */
  bootTimeoutMs?: number;
  /**
   * Fetch missing MachineN base assets on demand through @machinen/cli, then
   * retry rootfs/kernel/dtb resolution once. Default: true.
   */
  autoProvisionBaseAssets?: boolean;
  /**
   * Optional programmatic base-asset provisioner. The built-in fallback runs
   * the project-local `@machinen/cli install --json` because @machinen/runtime
   * 0.6.1 does not export the release-asset downloader used by that command.
   */
  baseAssetProvisioner?: MachinenBaseAssetProvisioner;
  /** Project root used to resolve/run the built-in @machinen/cli provisioner. Default: process.cwd(). */
  projectRoot?: string;
  /** Explicit @machinen/cli executable for the built-in provisioner. */
  machinenCliBin?: string;
  /** Deadline for the on-demand `machinen install --json` prefetch. Default 10m. */
  assetProvisionTimeoutMs?: number;
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
          '`pnpm add @machinen/runtime@0.6.1 @machinen/cli@0.6.1` then `pnpm exec machinen install` to fetch ' +
          `base assets. Underlying error: ${(error as Error)?.message ?? error}`,
      );
    },
  );
  return runtimePromise;
}

function missingBaseAssetCode(error: unknown): string | undefined {
  if (!isRecord(error) || typeof error.code !== 'string') return undefined;
  return error.code;
}

function isMissingBaseAssetError(error: unknown): boolean {
  const code = missingBaseAssetCode(error);
  return (
    code === 'PROVISION_BASE_NOT_FOUND' ||
    code === 'PROVISION_KERNEL_NOT_FOUND' ||
    code === 'PROVISION_DTB_NOT_FOUND'
  );
}

function resolveMachinenCliBin(opts: MachinenDriverOptions): string | undefined {
  const projectRoot = opts.projectRoot ?? process.cwd();
  if (opts.machinenCliBin) {
    return path.resolve(projectRoot, opts.machinenCliBin);
  }

  try {
    const requireFromProject = createRequire(path.join(projectRoot, 'package.json'));
    const pkgPath = requireFromProject.resolve('@machinen/cli/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin?: string | Record<string, string> };
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.machinen;
    if (!bin) return undefined;
    return path.resolve(path.dirname(pkgPath), bin);
  } catch {
    return undefined;
  }
}

async function provisionBaseAssets(
  opts: MachinenDriverOptions,
  timeoutMs: number,
  log: (line: string) => void,
): Promise<void> {
  if (opts.baseAssetProvisioner) {
    await opts.baseAssetProvisioner({ timeoutMs, log });
    return;
  }
  await runBaseAssetProvision(opts, timeoutMs, log);
}

async function runBaseAssetProvision(
  opts: MachinenDriverOptions,
  timeoutMs: number,
  log: (line: string) => void,
): Promise<void> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const cliBin = resolveMachinenCliBin(opts);
  if (!cliBin) {
    throw new Error(
      '[machinen-plugin] MachineN base assets are missing, and @machinen/cli is not installed ' +
        `from ${projectRoot}. Install @machinen/cli next to the app, set machinenCliBin, ` +
        'or prefetch assets with `machinen install`.',
    );
  }

  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_ASSET_PROVISION_TIMEOUT_MS;
  log(`[machinen] base assets missing; running ${cliBin} install --json`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cliBin, 'install', '--json'], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, timeout);
    timer.unref();

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendBoundedOutput(stdout, chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendBoundedOutput(stderr, chunk.toString('utf8'));
    });
    child.on('error', (error) => {
      finish(new Error(`[machinen-plugin] failed to start MachineN asset provisioning: ${error.message}`));
    });
    child.on('exit', (code, signal) => {
      if (timedOut) {
        finish(new Error(`[machinen-plugin] MachineN asset provisioning timed out after ${timeout}ms`));
        return;
      }
      if (code === 0) {
        const suffix = stdout.trim() ? `: ${stdout.trim()}` : '';
        log(`[machinen] base assets ready${suffix}`);
        finish();
        return;
      }
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      const detail = stderr.trim() || stdout.trim();
      finish(
        new Error(
          `[machinen-plugin] MachineN asset provisioning failed with ${reason}` +
            (detail ? `: ${detail}` : ''),
        ),
      );
    });
  });
}

function appendBoundedOutput(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > ASSET_PROVISION_OUTPUT_MAX_BYTES
    ? next.slice(next.length - ASSET_PROVISION_OUTPUT_MAX_BYTES)
    : next;
}

async function resolveBaseBootBundle(
  runtime: MachinenRuntime,
  opts: MachinenDriverOptions,
  log: (line: string) => void,
  image?: string,
): Promise<BaseBootBundle> {
  const resolve = (): BaseBootBundle => ({
    image: image ?? runtime.resolveBaseRootfs(),
    assets: baseBootAssets(runtime),
  });

  try {
    return resolve();
  } catch (error) {
    if (opts.autoProvisionBaseAssets === false || !isMissingBaseAssetError(error)) throw error;
    await provisionBaseAssets(
      opts,
      opts.assetProvisionTimeoutMs ?? DEFAULT_ASSET_PROVISION_TIMEOUT_MS,
      log,
    );
    try {
      return resolve();
    } catch (retryError) {
      throw new Error(
        '[machinen-plugin] MachineN base assets are still unavailable after base asset provisioning: ' +
          `${(retryError as Error)?.message ?? retryError}`,
        { cause: retryError },
      );
    }
  }
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

type GuestProgram = {
  runtimeName: 'node' | 'java';
  bundlePath: string;
  guestPath: string;
  installPackages: string[];
  launchCommand: string;
  typesPath?: string;
  rootDiskSizeBytes?: number;
};

interface MachinenMachineManifest {
  format?: string;
  runtime?: string;
  program?: string;
  types?: string;
  rootDiskSizeBytes?: number;
}

function safeMachineImageMember(root: string, member: string, field: string): string {
  if (!member || path.isAbsolute(member)) {
    throw new Error(`[machinen-plugin] machine image ${field} must be a relative path`);
  }
  const target = path.resolve(root, member);
  const rootWithSep = `${path.resolve(root)}${path.sep}`;
  if (!target.startsWith(rootWithSep)) {
    throw new Error(`[machinen-plugin] machine image ${field} escapes the image directory`);
  }
  return target;
}

async function guestProgramForMachineImage(imageDir: string): Promise<GuestProgram | undefined> {
  const manifestPath = path.join(imageDir, MACHINE_IMAGE_MANIFEST);
  if (!existsSync(manifestPath)) return undefined;

  let manifest: MachinenMachineManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as MachinenMachineManifest;
  } catch (error) {
    throw new Error(
      `[machinen-plugin] machine image manifest ${manifestPath} is not readable JSON: ` +
        `${(error as Error)?.message ?? error}`,
    );
  }
  if (manifest.format !== 'machinen-machine@1') {
    throw new Error(
      `[machinen-plugin] machine image manifest ${manifestPath} has unsupported format "${String(manifest.format)}"`,
    );
  }
  if (manifest.runtime !== 'java') {
    throw new Error(
      `[machinen-plugin] machine image manifest ${manifestPath} has unsupported runtime "${String(manifest.runtime)}"`,
    );
  }
  if (typeof manifest.program !== 'string') {
    throw new Error(`[machinen-plugin] machine image manifest ${manifestPath} must name a program`);
  }

  return {
    runtimeName: 'java',
    bundlePath: safeMachineImageMember(imageDir, manifest.program, 'program'),
    guestPath: JAVA_GUEST_BUNDLE,
    installPackages: ['default-jre-headless', 'ca-certificates'],
    launchCommand: `exec java -jar ${JAVA_GUEST_BUNDLE}`,
    typesPath:
      typeof manifest.types === 'string'
        ? safeMachineImageMember(imageDir, manifest.types, 'types')
        : undefined,
    rootDiskSizeBytes: manifest.rootDiskSizeBytes,
  };
}

async function guestProgramFor(bundlePath: string): Promise<GuestProgram | undefined> {
  const info = await stat(bundlePath).catch(() => undefined);
  if (info?.isDirectory()) {
    return guestProgramForMachineImage(bundlePath);
  }
  if (/\.(mjs|js)$/.test(bundlePath)) {
    return {
      runtimeName: 'node',
      bundlePath,
      guestPath: NODE_GUEST_BUNDLE,
      installPackages: ['nodejs', 'ca-certificates'],
      launchCommand: `exec node ${NODE_GUEST_BUNDLE}`,
    };
  }
  return undefined;
}

function installCommand(packages: string[]): string {
  return (
    'mkdir -p /usr/share/man/man1 && DEBIAN_FRONTEND=noninteractive apt-get update && ' +
    `DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${packages.join(' ')} </dev/null 1>&2 || ` +
    "{ status=$?; tail -120 /var/log/apt/term.log /var/log/dpkg.log 2>/dev/null >&2; exit $status; }"
  );
}

function assertValidEnvKey(key: string): void {
  if (!ENV_KEY_RE.test(key)) {
    throw new Error(
      `[machinen-plugin] invalid env key "${key}": keys must match ${ENV_KEY_RE.source}`,
    );
  }
}

function assertValidEnvKeys(env: Record<string, string> | undefined): void {
  for (const key of Object.keys(env ?? {})) assertValidEnvKey(key);
}

function buildGuestEnv(guestPort: number, extraEnv: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {
    HOST: '0.0.0.0', // gvproxy forwards arrive over the guest NIC, not loopback
    PORT: String(guestPort),
    ...(extraEnv ?? {}),
  };
  assertValidEnvKeys(env);
  return env;
}

function buildGuestLauncher(env: Record<string, string>, launchCommand: string): string {
  return [
    '#!/bin/sh',
    ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
    `${launchCommand} >>/var/log/federated-guest.log 2>&1`,
    '',
  ].join('\n');
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

async function throwWithGuestLogAndKill(vm: MachinenVm, error: unknown): Promise<never> {
  const enriched = await withGuestLogOnHealthTimeout(vm, error);
  await vm.kill().catch(() => {});
  throw enriched;
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

async function readSnapshotMarker(snapDir: string): Promise<SnapMarker | undefined> {
  let raw: string;
  try {
    raw = await readFile(path.join(snapDir, SNAP_MARKER), 'utf8');
  } catch {
    // Bundle produced outside this driver — fall back to entry params.
    return undefined;
  }
  let marker: unknown;
  try {
    marker = JSON.parse(raw);
  } catch {
    throw new Error(
      `[machinen-plugin] snapshot "${snapDir}" has an invalid ${SNAP_MARKER}; refusing ambiguous restore`,
    );
  }
  if (!isSnapMarker(marker)) {
    throw new Error(
      `[machinen-plugin] snapshot "${snapDir}" has an invalid MachineN shell marker; refusing ambiguous restore`,
    );
  }
  return marker;
}

async function shellIdentity(
  image: string,
  assets: { kernel: string; dtb?: string },
): Promise<VmstateShellIdentity> {
  const rootfsDigest = `sha256:${await sha256File(image)}`;
  const kernelDigest = `sha256:${await sha256File(assets.kernel)}`;
  if (!assets.dtb) return { rootfsDigest, kernelDigest };
  return {
    rootfsDigest,
    kernelDigest,
    dtbDigest: `sha256:${await sha256File(assets.dtb)}`,
  };
}

function buildHandle(
  spec: MachineSpec,
  vm: MachinenVm,
  hostPort: number,
  guestPort: number,
  image: string,
  shell: () => Promise<VmstateShellIdentity>,
  snapshotDir: string,
  log: (line: string) => void,
): MachineHandle {
  const handle = httpMachineHandle(`http://127.0.0.1:${hostPort}`);

  const snapshot = async (): Promise<MachinenSnapshotDescriptor> => {
    // The x86_64 base rootfs ships an aarch64 /sbin/machinen-vmstate-reseed in the
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
      shell: await shell(),
      snappedAt: new Date().toISOString(),
    };
    await writeHostFile(path.join(outDir, SNAP_MARKER), JSON.stringify(marker, null, 2));
    log(`[machinen] ${spec.remoteName}: snapshot -> ${outDir} (${Date.now() - started}ms)`);
    return { snapDir: outDir, image, shell: marker.shell };
  };

  const fork = async (): Promise<never> => {
    throw new Error(
      '[machinen-plugin] machinenDriver: fork() is not supported on amd64 with machinen 0.6.1 ' +
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

export function machinenDriver(opts: MachinenDriverOptions = {}): MachineDriver {
  const snapshotDir = opts.snapshotDir ?? path.join('.machinen', 'vm-snapshots');
  const guestReadyTimeoutMs = opts.guestReadyTimeoutMs ?? 60_000;
  const bootTimeoutMs = opts.bootTimeoutMs ?? Math.max(DEFAULT_BOOT_TIMEOUT_MS, guestReadyTimeoutMs);
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  assertValidEnvKeys(opts.env);

  /**
   * The boot bundle THIS host offers (provisioning missing base assets on
   * demand) — never derived from paths recorded inside a pulled bundle.
   */
  function localBootBundle(runtime: MachinenRuntime): Promise<BaseBootBundle> {
    return resolveBaseBootBundle(runtime, opts, log, opts.image);
  }

  // Memoized per driver: the local assets do not change within a process,
  // and hashing a multi-GB rootfs on every restore would be pure waste.
  let localShellPromise: Promise<VmstateShellIdentity> | undefined;
  function localShell(runtime: MachinenRuntime): Promise<VmstateShellIdentity> {
    localShellPromise ??= localBootBundle(runtime)
      .then(({ image, assets }) => shellIdentity(image, assets))
      .catch((error: unknown) => {
        localShellPromise = undefined;
        throw error;
      });
    return localShellPromise;
  }

  async function bootFresh(spec: MachineSpec, program: GuestProgram): Promise<MachineHandle> {
    const runtime = await loadRuntime();
    const bundle = await readFile(program.bundlePath);
    const { image, assets } = await localBootBundle(runtime);
    const guestPort = guestPortFor(spec);
    const hostPort = await getFreePort();
    const memory = Number(spec.params.get('memory')) || opts.memoryMib || DEFAULT_MEMORY_MIB;
    const rootDiskSizeBytes =
      Number(spec.params.get('rootDiskSizeBytes')) ||
      opts.rootDiskSizeBytes ||
      program.rootDiskSizeBytes ||
      (program.runtimeName === 'java' ? DEFAULT_JAVA_ROOT_DISK_BYTES : undefined);
    const name = vmName(spec.remoteName);

    const t0 = Date.now();
    log(`[machinen] ${spec.remoteName}: booting VM "${name}" (${memory} MiB, 127.0.0.1:${hostPort} -> guest:${guestPort})`);
    const vm = await withVmStartTimeout(
      runtime.boot({
        image,
        ...assets,
        // The supervised cmd just keeps PID 1's workload alive; the actual
        // guest server is started via exec below so the same base image works
        // before node is installed. Whole-VM snapshots capture it regardless.
        cmd: ['/bin/sh', '-c', 'exec sleep infinity'],
        name,
        // Explicit memory always (amd64 KVM APIC-page collision in auto-sizing).
        memory,
        ...(rootDiskSizeBytes ? { rootDiskSizeBytes } : {}),
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
      if (!opts.image && program.installPackages.length > 0) {
        // provision() stalls on x86_64/KVM (vsock exec inside provision
        // times out at 300s); boot-then-exec does the same install in ~5s.
        await checkedExec(
          vm,
          installCommand(program.installPackages),
          `install ${program.runtimeName} in guest`,
          { execTimeoutMs: 240_000 },
        );
        log(`[machinen] ${spec.remoteName}: ${program.runtimeName} installed in guest (${Date.now() - booted}ms)`);
      }

      await vm.writeFile(program.guestPath, bundle);
      const env = buildGuestEnv(guestPort, opts.env);
      if (program.typesPath && existsSync(program.typesPath)) {
        await vm.writeFile(JAVA_TYPES_FILE, await readFile(program.typesPath));
        env.MACHINEN_TYPES_FILE ??= JAVA_TYPES_FILE;
      }
      const launcher = buildGuestLauncher(env, program.launchCommand);
      await vm.writeFile(GUEST_LAUNCHER, launcher, { mode: 0o600 });
      await checkedExec(
        vm,
        `nohup /bin/sh ${GUEST_LAUNCHER} >/dev/null 2>&1 & sleep 0.2; true`,
        'start guest launcher',
      );

      const handle = buildHandle(spec, vm, hostPort, guestPort, image, () => localShell(runtime), snapshotDir, log);
      const readyMs = await waitForGuest(
        () => handle.health?.() ?? Promise.resolve(false),
        `boot of "${spec.remoteName}"`,
        guestReadyTimeoutMs,
      );
      log(`[machinen] ${spec.remoteName}: guest healthy ${readyMs}ms after start (${Date.now() - t0}ms total)`);
      return handle;
    } catch (error) {
      return await throwWithGuestLogAndKill(vm, error);
    }
  }

  async function bootFromSnapshot(spec: MachineSpec, snapDir: string): Promise<MachineHandle> {
    const runtime = await loadRuntime();
    const marker = await readSnapshotMarker(snapDir);
    if (!marker?.shell) {
      throw new Error(
        `[machinen-plugin] snapshot "${snapDir}" has no MachineN shell identity; refusing ambiguous restore`,
      );
    }
    const guestPort = resolveGuestPort(spec, marker);
    const hostPort = await getFreePort();
    const name = vmName(spec.remoteName);
    const { image: localRootfs, assets } = await localBootBundle(runtime);
    // The shell this host offers is derived from ITS OWN assets. marker.image
    // is a producer-host path inside an untrusted bundle: reading it would
    // break cross-host restores (ENOENT) and hand hostile bundles an
    // arbitrary-file hash oracle.
    const hostShell = await localShell(runtime);
    if (!sameShell(marker.shell, hostShell)) {
      throw new Error(
        `[machinen-plugin] snapshot "${snapDir}" shell mismatch: snapshot requires ` +
          `${formatShell(marker.shell)}, this host has ${formatShell(hostShell)}`,
      );
    }

    const t0 = Date.now();
    log(`[machinen] ${spec.remoteName}: restoring VM "${name}" from ${snapDir} (127.0.0.1:${hostPort} -> guest:${guestPort})`);
    // No explicit memory here: the vmstate bundle dictates the guest RAM
    // topology and a mismatched override is refused at restore.
    const vm = await withVmStartTimeout(
      runtime.restore({
        snapDir,
        ...assets,
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
      // Re-snapshots of this restored VM record THIS host's rootfs path (its
      // digests were just verified to match the marker shell).
      const handle = buildHandle(spec, vm, hostPort, guestPort, localRootfs, async () => marker.shell, snapshotDir, log);
      const readyMs = await waitForGuest(
        () => handle.health?.() ?? Promise.resolve(false),
        `restore of "${spec.remoteName}"`,
        guestReadyTimeoutMs,
      );
      log(`[machinen] ${spec.remoteName}: restored guest healthy in ${Date.now() - t0}ms (poll ${readyMs}ms)`);
      return handle;
    } catch (error) {
      return await throwWithGuestLogAndKill(vm, error);
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
      const program = await guestProgramFor(spec.image);
      if (program) {
        return bootFresh(spec, program);
      }
      throw new Error(
        `[machinen-plugin] machinenDriver cannot boot "${spec.image}": expected a .js/.mjs ` +
          'guest bundle, a machinen-machine@1 image directory, or a machinen snapshot bundle directory',
      );
    },
  };
}
