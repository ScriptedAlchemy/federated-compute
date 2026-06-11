// Android lab backend: the machine lifecycle arc (boot → freeze → resume)
// applied to a WHOLE OPERATING SYSTEM. A real machinen microVM (KVM) runs a
// QEMU-emulated Android-x86 device; an app is launched over adb; then the
// outer VM is frozen into a vmstate bundle and restored — and the Android
// device, the app, and every adb TCP connection inside simply continue.
//
// Unlike page 01's lifecycle card (process driver, app-level .snap bundles),
// nothing here is federation-protocol traffic: the evidence is the device
// itself — app pid, kernel boot_id, uptime, and screenshots taken before the
// freeze and after the resume.
//
// Steps are minutes-long (single-core TCG emulation of Android), so every
// mutation is an async job: POST kicks it off, GET /api/android/status polls
// phase + a live progress log.
import { existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import type http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// ---- the machinen runtime (optional peer, lazily loaded) --------------------
// Kept external by rsbuild (see rsbuild.config.ts): the runtime ships native
// VMM binaries that must not be bundled. Loading it only when the user clicks
// "power on" keeps the rest of the web demo independent of KVM.

interface VmExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface AndroidVm {
  readonly pid: number;
  exec(cmd: string, opts?: { execTimeoutMs?: number }): Promise<VmExecResult>;
  writeFile(guestPath: string, contents: Buffer | string, opts?: { mode?: number }): Promise<void>;
  snapshot(opts: { outDir: string; timeoutMs?: number }): Promise<{ snapDir: string }>;
  kill(): Promise<void>;
}

interface AndroidRuntime {
  boot(opts: Record<string, unknown>): Promise<AndroidVm>;
  restore(opts: Record<string, unknown>): Promise<AndroidVm>;
  attach(opts: { pid?: number }): Promise<AndroidVm>;
  resolveBaseRootfs(): string;
  resolveBaseKernel(): string;
  resolveBaseDtb(): string | undefined;
}

let runtimePromise: Promise<AndroidRuntime> | undefined;

async function loadRuntime(): Promise<AndroidRuntime> {
  runtimePromise ??= import('@machinen/runtime').then(
    (mod) => mod as unknown as AndroidRuntime,
    (error: unknown) => {
      runtimePromise = undefined;
      throw new Error(
        `@machinen/runtime is not installed (optional peer — the explicit opt-in to VMs): ${
          (error as Error)?.message ?? error
        }`,
      );
    },
  );
  return runtimePromise;
}

// ---- the recipe constants (empirically validated, see scripts/demo-android.mjs)
// Outer guest RAM. HARD CEILING ~1.9 GiB: machinen 0.4.0 reads the whole
// state.vmstate back with readFileSync, which throws ERR_FS_FILE_TOO_LARGE
// past 2 GiB — and the vmstate is essentially a full RAM image.
const OUTER_MIB = 1880;
// Android's RAM inside the inner QEMU. 4.4/KitKat is comfortable at 768 MB,
// and outer minus inner leaves headroom for Debian + qemu + adb.
const INNER_MB = 768;
// Android-x86 4.4-r5: the newest release whose Dalvik runtime boots in ~3min
// on a SINGLE emulated core (the machinen guest has one vCPU and no nested
// KVM, so the inner QEMU runs pure TCG software emulation).
const ISO_URL =
  'https://downloads.sourceforge.net/project/android-x86/Release%204.4/android-x86-4.4-r5.iso';
const ADB_FWD = 15555; // guest-local forward into the inner device's adbd
// QEMU's built-in websocket VNC listener (inside the machinen guest). A
// gvproxy port forward maps a host loopback port onto it at boot/restore;
// the host server splices browser websockets through (GET /vnc upgrade), so
// page 04 runs noVNC straight against the device framebuffer.
const VNC_WS_GUEST = 15901;
const APP = 'com.android.settings';
const APP_ACTIVITY = `${APP}/.Settings`;
const ADB = `adb -s 127.0.0.1:${ADB_FWD}`;
const SNAP_DIR = path.resolve(import.meta.dirname, '../.machinen/android-snapshots');
// Validated boots range 3min (idle host) to ~12min (loaded host) — TCG speed
// is a direct function of free host CPU.
const ANDROID_BOOT_TIMEOUT_MS = 20 * 60_000;

// machinen 0.4.0 amd64 ships an aarch64 /sbin/machinen-vmstate-reseed; every
// restore would die with BOOT_VMSTATE_RESEED_FAILED. Same functional shim as
// the machinen driver / e2e: reseed the guest CSPRNG from the host seed.
const RESEED_SHIM = `#!/bin/sh
if [ -x /usr/bin/perl ]; then
  exec /usr/bin/perl -e '
    my $seed = pack("H*", $ARGV[0]);
    open(my $fh, "+<", "/dev/urandom") or die "open /dev/urandom: $!";
    my $req = pack("l l a*", 8 * length($seed), length($seed), $seed);
    ioctl($fh, 0x40085203, $req) or die "RNDADDENTROPY: $!";
    ioctl($fh, 0x5207, 0) or die "RNDRESEEDCRNG: $!";
  ' "$1"
fi
printf '%s' "$1" > /dev/urandom
exit 0
`;

// ---- state ------------------------------------------------------------------

export type AndroidPhase =
  | 'cold'
  | 'powering-on'
  | 'device-ready'
  | 'app-running'
  | 'freezing'
  | 'frozen'
  | 'restoring'
  | 'resumed'
  | 'error';

interface Evidence {
  appPid: string;
  bootId: string;
  uptimeSec: number;
  /** data: URI of an adb screencap, straight off the device's framebuffer. */
  screenshot?: string;
}

interface AndroidState {
  phase: AndroidPhase;
  /** Human-readable current sub-step while a job runs. */
  step?: string;
  busy: boolean;
  log: { t: string; line: string }[];
  error?: string;
  before?: Evidence;
  after?: Evidence;
  verdict?: { pidSame: boolean; bootIdSame: boolean; uptimeGrew: boolean };
  bundleBytes?: number;
  timings: Record<string, number>;
}

const state: AndroidState = { phase: 'cold', busy: false, log: [], timings: {} };
let vm: AndroidVm | undefined;
let bundleDir: string | undefined;
/** Host loopback port forwarded to the inner qemu's websocket VNC listener. */
let vncHostPort: number | undefined;
/** True from the moment the inner qemu launches until the VM dies. */
let vncLive = false;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** The websocket VNC target for the host server's /vnc upgrade proxy. */
export function androidVncPort(): number | undefined {
  return vncLive && vm ? vncHostPort : undefined;
}

function logLine(line: string): void {
  state.log.push({ t: new Date().toISOString().slice(11, 19), line });
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
}

function setStep(step: string): void {
  state.step = step;
  logLine(step);
}

// ---- guest plumbing ----------------------------------------------------------

async function guestExec(cmd: string, timeoutMs = 120_000): Promise<string> {
  if (!vm) throw new Error('no VM is running');
  const r = await vm.exec(cmd, { execTimeoutMs: timeoutMs });
  return r.stdout.trim();
}

/** Same, but tolerant of the exec agent re-registering after a restore. */
async function guestExecRetry(cmd: string, attempts = 15, timeoutMs = 60_000): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await guestExec(cmd, timeoutMs);
    } catch (err) {
      lastErr = err;
      await sleep(2_000);
    }
  }
  throw new Error(`guest exec never succeeded: ${(lastErr as Error)?.message ?? lastErr}`);
}

/**
 * Run a command on the Android device's ROOT CONSOLE — the serial port is a
 * unix socket inside the guest, and android-x86 puts a root shell on it.
 * This is how adbd gets enabled: 4.4's init.rc has adbd `disabled` (it only
 * auto-starts on USB gadget events, and a QEMU PC has no USB gadget).
 */
const consoleCmd = (cmd: string, waitSec = 4) =>
  `(printf '${cmd.replace(/'/g, `'\\''`)}\\n'; sleep ${waitSec}) | socat -T ${waitSec + 2} - UNIX-CONNECT:/root/serial.sock`;

/**
 * The adb server's TCP session can come back stale after a freeze/restore
 * (`adb devices` reports the device offline); a disconnect/reconnect cycle
 * always recovers it. Retried because the freshly-thawed guest can be slow.
 */
async function ensureAdbOnline(): Promise<void> {
  await guestExecRetry(
    `adb disconnect 127.0.0.1:${ADB_FWD} >/dev/null 2>&1; ` +
      `adb connect 127.0.0.1:${ADB_FWD} >/dev/null 2>&1; sleep 1; ` +
      `adb devices | grep '127.0.0.1:${ADB_FWD}' | grep -qw device && echo online`,
    10,
    30_000,
  );
}

/** App pid + kernel boot_id + uptime, read over adb. The whole verdict. */
async function captureEvidence(withShot: boolean): Promise<Evidence> {
  await ensureAdbOnline();
  const raw = await guestExecRetry(
    `${ADB} shell "pidof ${APP}; cat /proc/sys/kernel/random/boot_id; cat /proc/uptime" | tr -d '\\r'`,
  );
  const [appPid = '', bootId = '', uptime = ''] = raw.split('\n').map((s) => s.trim());
  const evidence: Evidence = { appPid, bootId, uptimeSec: parseFloat(uptime) || 0 };
  if (withShot) {
    const b64 = await guestExecRetry(
      `${ADB} shell screencap -p /sdcard/shot.png && ${ADB} pull /sdcard/shot.png /root/shot.png >/dev/null && base64 /root/shot.png | tr -d '\\n'`,
      5,
      120_000,
    );
    evidence.screenshot = `data:image/png;base64,${b64}`;
  }
  return evidence;
}

async function killVm(): Promise<void> {
  await vm?.kill().catch(() => {});
  vm = undefined;
  vncLive = false;
}

// ---- the jobs ----------------------------------------------------------------

/** Serialize jobs and funnel failures into the error phase. */
function runJob(name: string, job: () => Promise<void>): void {
  state.busy = true;
  state.error = undefined;
  void job()
    .catch(async (err: unknown) => {
      state.phase = 'error';
      state.error = (err as Error)?.message ?? String(err);
      logLine(`ERROR: ${state.error}`);
      // A half-built lab is not recoverable mid-arc; reclaim the VM.
      if (name === 'power-on') await killVm();
    })
    .finally(() => {
      state.busy = false;
      state.step = undefined;
    });
}

async function jobPowerOn(): Promise<void> {
  const runtime = await loadRuntime();
  const t0 = Date.now();

  setStep('booting the outer machinen microVM (KVM)…');
  const dtb = runtime.resolveBaseDtb?.();
  vncHostPort = await freePort();
  vm = await runtime.boot({
    image: runtime.resolveBaseRootfs(),
    kernel: runtime.resolveBaseKernel(),
    ...(dtb ? { dtb } : {}),
    cmd: ['/bin/sh', '-c', 'exec sleep infinity'],
    name: `android-lab-${process.pid}`,
    memory: OUTER_MIB,
    rootDiskSizeBytes: 8 * 1024 ** 3,
    portForward: [{ hostPort: vncHostPort, guestPort: VNC_WS_GUEST }],
    timeoutMs: 180_000,
  });
  state.timings.outerBootMs = Date.now() - t0;
  logLine(`outer VM up in ${state.timings.outerBootMs}ms (${OUTER_MIB} MiB, 1 vCPU)`);

  setStep('installing qemu + adb + tools inside the guest…');
  let t = Date.now();
  await guestExec('apt-get update', 300_000);
  await guestExec(
    'DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ' +
      'qemu-system-x86 adb wget ca-certificates procps libarchive-tools socat </dev/null',
    600_000,
  );
  state.timings.toolsMs = Date.now() - t;
  logLine(`qemu-system-x86 + adb installed (${state.timings.toolsMs}ms)`);

  setStep('downloading the Android-x86 4.4 ISO (441 MB) into the guest…');
  t = Date.now();
  await guestExec(`wget -q --tries=3 -O /root/android.iso '${ISO_URL}'`, 900_000);
  await guestExec('mkdir -p /root/boot && cd /root/boot && bsdtar -xf /root/android.iso kernel initrd.img');
  state.timings.isoMs = Date.now() - t;
  logLine(`ISO fetched + kernel/initrd extracted (${state.timings.isoMs}ms)`);

  setStep('powering on the Android device (QEMU, single-core TCG)…');
  t = Date.now();
  await guestExec(
    `qemu-system-x86_64 -m ${INNER_MB} -smp 1 -accel tcg ` +
      '-kernel /root/boot/kernel -initrd /root/boot/initrd.img ' +
      // The ISO's own "VESA mode" live entry, plus a serial console: the
      // bootloader path sets a VBE framebuffer so SurfaceFlinger renders
      // headless, and init puts a root shell on ttyS0 (our control channel).
      `-append 'root=/dev/ram0 androidboot.hardware=android_x86 nomodeset vga=788 console=ttyS0 quiet SRC= DATA=' ` +
      '-cdrom /root/android.iso -vga std ' +
      // The display backend IS the VNC server: native RFB on :0 plus a
      // websocket listener page 04's noVNC reaches through the forward.
      // usb-tablet gives VNC absolute pointer events — clicks land where
      // the cursor is, which a PS/2 relative mouse cannot guarantee.
      `-vnc :0,websocket=${VNC_WS_GUEST} -usb -device usb-tablet ` +
      '-monitor unix:/root/qmon.sock,server,nowait ' +
      '-chardev socket,id=ser0,path=/root/serial.sock,server=on,wait=off,logfile=/root/serial.log ' +
      '-serial chardev:ser0 ' +
      `-netdev user,id=n0,hostfwd=tcp:127.0.0.1:${ADB_FWD}-:5555 -device e1000,netdev=n0 ` +
      '-daemonize -pidfile /root/qemu.pid',
    60_000,
  );
  vncLive = true;
  logLine('device framebuffer is live — watch the boot on page 04 (device screen)');

  const deadline = Date.now() + ANDROID_BOOT_TIMEOUT_MS;
  let booted = false;
  while (Date.now() < deadline) {
    const out = await guestExec(consoleCmd('getprop sys.boot_completed', 3), 30_000).catch(() => '');
    if (/^1$/m.test(out.replace(/^.*# /gm, ''))) {
      booted = true;
      break;
    }
    setStep(`Android booting… ${Math.round((Date.now() - t) / 1000)}s on one emulated core`);
    await sleep(15_000);
  }
  if (!booted) throw new Error('Android did not reach sys.boot_completed=1 within 15 minutes');
  state.timings.androidBootMs = Date.now() - t;
  logLine(`Android booted: sys.boot_completed=1 (${state.timings.androidBootMs}ms)`);

  setStep('enabling adbd over TCP from the device root console…');
  await guestExec(consoleCmd('setprop service.adb.tcp.port 5555 && start adbd', 3), 30_000);
  await sleep(2_000);
  const dev = await guestExec(`adb connect 127.0.0.1:${ADB_FWD} && sleep 2 && adb devices`, 60_000);
  if (!dev.includes(`127.0.0.1:${ADB_FWD}\tdevice`)) {
    throw new Error(`adb device did not come online:\n${dev}`);
  }
  logLine('adb connected — the device is live');
  state.timings.totalPowerOnMs = Date.now() - t0;
  state.phase = 'device-ready';
}

async function jobLaunchApp(): Promise<void> {
  setStep(`launching ${APP} on the device…`);
  const t = Date.now();
  await guestExec(`${ADB} shell "am start -n ${APP_ACTIVITY}"`, 60_000);
  await sleep(8_000); // single-core TCG: give the activity time to draw
  setStep('capturing evidence: app pid, boot_id, uptime, screenshot…');
  const evidence = await captureEvidence(true);
  if (!/^\d+$/.test(evidence.appPid)) {
    throw new Error(`app did not start: pidof ${APP} -> "${evidence.appPid}"`);
  }
  state.timings.launchMs = Date.now() - t;
  state.before = evidence;
  state.after = undefined;
  state.verdict = undefined;
  state.phase = 'app-running';
  logLine(`${APP} running: pid=${evidence.appPid} uptime=${evidence.uptimeSec}s`);
}

async function jobFreeze(): Promise<void> {
  if (!vm) throw new Error('no VM to freeze');
  const runtime = await loadRuntime();
  setStep('freezing the WHOLE VM: Android, the app, adb — RAM + disk + vCPU…');
  // Patch the mis-arched reseed helper before the state we freeze is final.
  await vm.writeFile('/sbin/machinen-vmstate-reseed', RESEED_SHIM, { mode: 0o755 });
  await rm(SNAP_DIR, { recursive: true, force: true });
  await mkdir(SNAP_DIR, { recursive: true });
  bundleDir = path.join(SNAP_DIR, `device-${Date.now().toString(36)}`);
  const t = Date.now();
  // Snapshot through an attach() handle (boot-owned handles can deadlock
  // under the CRIU engine — same workaround as the machinen driver).
  const snapVm = await runtime.attach({ pid: vm.pid });
  await snapVm.snapshot({ outDir: bundleDir, timeoutMs: 300_000 });
  state.timings.freezeMs = Date.now() - t;
  const vmstate = await stat(path.join(bundleDir, 'state.vmstate'));
  state.bundleBytes = vmstate.size;
  logLine(`vmstate bundle written: ${(vmstate.size / 1024 ** 3).toFixed(2)} GiB (${state.timings.freezeMs}ms)`);

  setStep('killing the source VM — the running device now exists only in the bundle');
  await killVm();
  state.phase = 'frozen';
  logLine('source VM killed. Android is a directory on disk now.');
}

async function jobResume(): Promise<void> {
  if (!bundleDir) throw new Error('no snapshot bundle to restore');
  const runtime = await loadRuntime();
  setStep('restoring the VM from the vmstate bundle…');
  const t = Date.now();
  const dtb = runtime.resolveBaseDtb?.();
  // Fresh host port, same guest port: the inner qemu's VNC listener was
  // frozen with the VM and thaws still listening — only the host-side
  // forward is new. Browser VNC sessions reconnect; the device kept drawing.
  vncHostPort = await freePort();
  vm = await runtime.restore({
    snapDir: bundleDir,
    kernel: runtime.resolveBaseKernel(),
    ...(dtb ? { dtb } : {}),
    name: `android-lab-restored-${process.pid}-${Date.now().toString(36)}`,
    portForward: [{ hostPort: vncHostPort, guestPort: VNC_WS_GUEST }],
    timeoutMs: 300_000,
  });
  vncLive = true;
  state.timings.restoreMs = Date.now() - t;
  logLine(`VM restored in ${state.timings.restoreMs}ms — checking on the device…`);

  setStep('capturing post-resume evidence over adb…');
  // No adb reconnect needed: the adb server, its TCP connection, and adbd
  // were all INSIDE the frozen VM — the whole connection graph thawed intact.
  const after = await captureEvidence(true);
  state.after = after;
  const before = state.before;
  state.verdict = before
    ? {
        pidSame: before.appPid !== '' && before.appPid === after.appPid,
        bootIdSame: before.bootId === after.bootId,
        uptimeGrew: after.uptimeSec > before.uptimeSec,
      }
    : undefined;
  state.phase = 'resumed';
  logLine(
    `device thawed: pid=${after.appPid} boot_id=${after.bootId.slice(0, 13)}… uptime=${after.uptimeSec}s`,
  );
  if (state.verdict && !(state.verdict.pidSame && state.verdict.bootIdSame && state.verdict.uptimeGrew)) {
    logLine('VERDICT MISMATCH — the device did not resume seamlessly');
  }
}

// ---- http handlers -----------------------------------------------------------

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function statusBody() {
  return {
    ...state,
    kvm: existsSync('/dev/kvm'),
    app: APP,
    /** Page 04 connects noVNC to GET /vnc whenever this is true. */
    vncLive: androidVncPort() !== undefined,
    config: { outerMib: OUTER_MIB, innerMb: INNER_MB, image: 'android-x86 4.4-r5' },
  };
}

/** Guard + start an async job; the response is the (already mutated) status. */
function step(
  res: http.ServerResponse,
  allowed: AndroidPhase[],
  next: AndroidPhase,
  name: string,
  job: () => Promise<void>,
): void {
  if (state.busy) return send(res, 409, { ...statusBody(), error: 'a step is already running' });
  if (!allowed.includes(state.phase)) {
    return send(res, 409, {
      ...statusBody(),
      error: `"${name}" is not valid in phase "${state.phase}" (expected ${allowed.join(' | ')})`,
    });
  }
  state.phase = next;
  runJob(name, job);
  send(res, 202, statusBody());
}

export function handleAndroidStatus(_req: http.IncomingMessage, res: http.ServerResponse): void {
  send(res, 200, statusBody());
}

export function handleAndroidBoot(_req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!existsSync('/dev/kvm')) {
    return send(res, 503, { ...statusBody(), error: 'no /dev/kvm on this host — real microVMs need KVM' });
  }
  step(res, ['cold', 'error'], 'powering-on', 'power-on', jobPowerOn);
}

export function handleAndroidLaunch(_req: http.IncomingMessage, res: http.ServerResponse): void {
  step(res, ['device-ready', 'app-running', 'resumed'], 'app-running', 'launch', jobLaunchApp);
}

export function handleAndroidFreeze(_req: http.IncomingMessage, res: http.ServerResponse): void {
  step(res, ['app-running', 'resumed'], 'freezing', 'freeze', jobFreeze);
}

export function handleAndroidResume(_req: http.IncomingMessage, res: http.ServerResponse): void {
  step(res, ['frozen'], 'restoring', 'resume', jobResume);
}

export function handleAndroidReset(_req: http.IncomingMessage, res: http.ServerResponse): void {
  if (state.busy) return send(res, 409, { error: 'a step is already running', ...statusBody() });
  runJob('reset', async () => {
    setStep('tearing the lab down…');
    await killVm();
    await rm(SNAP_DIR, { recursive: true, force: true });
    bundleDir = undefined;
    state.phase = 'cold';
    state.before = undefined;
    state.after = undefined;
    state.verdict = undefined;
    state.bundleBytes = undefined;
    state.timings = {};
    state.log = [];
    logLine('lab reset — cold');
  });
  send(res, 202, statusBody());
}

/** Best-effort teardown for server shutdown: VMs must not outlive the host. */
export async function disposeAndroidLab(): Promise<void> {
  await killVm();
}
