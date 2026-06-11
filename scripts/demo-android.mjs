// The lifecycle arc applied to a WHOLE OPERATING SYSTEM — headless version of
// the web demo's android lab page (apps/host/public/android.html).
//
// A real machinen microVM (KVM) boots Debian, installs QEMU + adb inside
// itself, downloads an Android-x86 4.4 ISO, and powers on an emulated Android
// device (single-core TCG — the machinen guest exposes no nested KVM). An app
// is launched over adb. Then the OUTER VM is frozen into a vmstate bundle
// (guest RAM + vCPU + disk — so the Android kernel, the app, adbd, and every
// TCP connection between them become bytes in a directory), killed, and
// restored. The proof of a seamless resume is the OS's own bookkeeping:
//
//   - `pidof` answers the SAME app pid,
//   - the kernel keeps the SAME boot_id (a fresh boot would mint a new one),
//   - uptime CONTINUED (it would reset on a reboot),
//   - two screenshots straddle the freeze: same app instance, same screen.
//
// Budget ~6 minutes: outer boot ~15s, tools ~10s, ISO ~15s, Android boot
// ~3min on one emulated core, freeze ~30s, restore ~25s.
//
// Requires Linux with usable /dev/kvm (or Apple Silicon) and machinen base
// assets (`pnpm exec machinen install`, fetched automatically on first boot).
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Resolve @machinen/runtime from the plugin package, where it is installed
// as the optional-peer opt-in to real VMs.
const require = createRequire(
  new URL('../packages/runtime-plugin/package.json', import.meta.url),
);
const runtime = await import(pathToFileURL(require.resolve('@machinen/runtime')).href);

// Outer guest RAM. Hard ceiling ~1.9 GiB: machinen 0.4.0 reads state.vmstate
// back with readFileSync (2 GiB buffer limit), and a vmstate is essentially a
// full RAM image.
const OUTER_MIB = 1880;
// Android 4.4 is comfortable at 768 MB; outer minus inner leaves headroom
// for Debian + the qemu process itself.
const INNER_MB = 768;
const ADB_FWD = 15555;
// Android-x86 4.4-r5: the newest release whose Dalvik runtime boots in
// minutes (not tens of minutes) on a single TCG-emulated core.
const ISO_URL =
  'https://downloads.sourceforge.net/project/android-x86/Release%204.4/android-x86-4.4-r5.iso';
const APP = 'com.android.settings';
const ADB = `adb -s 127.0.0.1:${ADB_FWD}`;

// machinen 0.4.0 amd64 ships an aarch64 reseed helper; identical functional
// shim to the machinen driver / e2e (reseeds the guest CSPRNG on restore).
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

if (process.platform === 'linux' && !existsSync('/dev/kvm')) {
  console.error('no /dev/kvm on this host — the android lab needs real microVMs');
  process.exit(1);
}

const log = (m) => console.log(`[android ${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function exec(vm, cmd, timeoutMs = 120_000) {
  return (await vm.exec(cmd, { execTimeoutMs: timeoutMs })).stdout.trim();
}

// The exec agent inside a restored VM can take a beat to re-register.
async function execRetry(vm, cmd, label, attempts = 15, timeoutMs = 60_000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await exec(vm, cmd, timeoutMs);
    } catch (err) {
      lastErr = err;
      await sleep(2_000);
    }
  }
  throw new Error(`${label}: ${lastErr?.message ?? lastErr}`);
}

// Run a command on the Android root console: android-x86 puts a root shell
// on the serial port, which qemu exposes as a unix socket inside the guest.
const consoleCmd = (cmd, waitSec = 4) =>
  `(printf '${cmd.replace(/'/g, `'\\''`)}\\n'; sleep ${waitSec}) | socat -T ${waitSec + 2} - UNIX-CONNECT:/root/serial.sock`;

const STATE_CMD = `${ADB} shell "pidof ${APP}; cat /proc/sys/kernel/random/boot_id; cat /proc/uptime" | tr -d '\\r'`;

const kernel = runtime.resolveBaseKernel();
const dtb = runtime.resolveBaseDtb?.();
const work = await mkdtemp(path.join(os.tmpdir(), 'android-demo-'));
const snapDir = path.join(work, 'bundle');
const timings = {};
let vm;
let restored;

try {
  console.log('=== Act 1: a microVM powers on an Android device inside itself ===');
  let t0 = Date.now();
  vm = await runtime.boot({
    image: runtime.resolveBaseRootfs(),
    kernel,
    ...(dtb ? { dtb } : {}),
    cmd: ['/bin/sh', '-c', 'exec sleep infinity'],
    name: `android-demo-${process.pid}`,
    memory: OUTER_MIB,
    // ~1.5 GiB actually written (qemu+adb, ISO, boot files); 4 GiB is ample.
    rootDiskSizeBytes: 4 * 1024 ** 3,
    timeoutMs: 180_000,
  });
  timings.outerBoot = Date.now() - t0;
  log(`outer microVM booted (${timings.outerBoot}ms, ${OUTER_MIB} MiB, vmm pid ${vm.pid})`);

  t0 = Date.now();
  await exec(vm, 'apt-get update', 300_000);
  await exec(
    vm,
    'DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ' +
      'qemu-system-x86 adb wget ca-certificates procps libarchive-tools socat </dev/null',
    600_000,
  );
  timings.tools = Date.now() - t0;
  log(`qemu + adb + tools installed inside the guest (${timings.tools}ms)`);

  t0 = Date.now();
  await exec(vm, `wget -q --tries=3 -O /root/android.iso '${ISO_URL}'`, 900_000);
  await exec(vm, 'mkdir -p /root/boot && cd /root/boot && bsdtar -xf /root/android.iso kernel initrd.img');
  timings.iso = Date.now() - t0;
  log(`Android-x86 4.4 ISO downloaded + kernel/initrd extracted (${timings.iso}ms)`);

  t0 = Date.now();
  await exec(
    vm,
    `qemu-system-x86_64 -m ${INNER_MB} -smp 1 -accel tcg ` +
      '-kernel /root/boot/kernel -initrd /root/boot/initrd.img ' +
      // The ISO's "VESA mode" live entry + a serial console: vga=788 gives
      // SurfaceFlinger a VBE framebuffer headless; init puts a root shell on
      // ttyS0 — the control channel for enabling adbd below.
      `-append 'root=/dev/ram0 androidboot.hardware=android_x86 nomodeset vga=788 console=ttyS0 quiet SRC= DATA=' ` +
      // Same display setup as the web lab: the VNC server IS the display
      // backend, usb-tablet gives absolute pointer events for VNC clicks.
      '-cdrom /root/android.iso -vga std -vnc :0,websocket=15901 -usb -device usb-tablet ' +
      '-monitor unix:/root/qmon.sock,server,nowait ' +
      '-chardev socket,id=ser0,path=/root/serial.sock,server=on,wait=off,logfile=/root/serial.log ' +
      '-serial chardev:ser0 ' +
      `-netdev user,id=n0,hostfwd=tcp:127.0.0.1:${ADB_FWD}-:5555 -device e1000,netdev=n0 ` +
      '-daemonize -pidfile /root/qemu.pid',
    60_000,
  );
  log('Android device powering on (single-core TCG emulation — be patient)');

  // 3min on an idle host, ~12min on a loaded one — TCG speed tracks free CPU.
  const bootDeadline = Date.now() + 20 * 60_000;
  let booted = false;
  while (Date.now() < bootDeadline) {
    const out = await exec(vm, consoleCmd('getprop sys.boot_completed', 3), 30_000).catch(() => '');
    if (/^1$/m.test(out.replace(/^.*# /gm, ''))) {
      booted = true;
      break;
    }
    log(`  ...still booting (${Math.round((Date.now() - t0) / 1000)}s)`);
    await sleep(15_000);
  }
  if (!booted) throw new Error('Android did not reach sys.boot_completed=1 within 15min');
  timings.androidBoot = Date.now() - t0;
  log(`Android booted: sys.boot_completed=1 (${timings.androidBoot}ms)`);

  // adbd is `disabled` in 4.4's init.rc (USB-gadget-triggered only, and an
  // emulated PC has no gadget) — enable it over TCP from the root console.
  await exec(vm, consoleCmd('setprop service.adb.tcp.port 5555 && start adbd', 3), 30_000);
  await sleep(2_000);
  const dev = await exec(vm, `adb connect 127.0.0.1:${ADB_FWD} && sleep 2 && adb devices`, 60_000);
  if (!dev.includes(`127.0.0.1:${ADB_FWD}\tdevice`)) throw new Error(`adb device not online:\n${dev}`);
  log('adb connected to the Android device');

  console.log('\n=== Act 2: launch an app, write down everything that must survive ===');
  await exec(vm, `${ADB} shell "am start -n ${APP}/.Settings"`, 60_000);
  await sleep(8_000);
  const before = (await exec(vm, STATE_CMD, 60_000)).split('\n').map((s) => s.trim());
  if (!/^\d+$/.test(before[0])) throw new Error(`app did not start: pidof -> "${before[0]}"`);
  log(`${APP} running: pid=${before[0]} boot_id=${before[1]} uptime=${before[2].split(' ')[0]}s`);
  await exec(
    vm,
    `${ADB} shell screencap -p /sdcard/shot.png && ${ADB} pull /sdcard/shot.png /root/s.png >/dev/null && base64 /root/s.png | tr -d '\\n'`,
    120_000,
  ).then((b64) => writeFile(path.join(work, 'before.png'), Buffer.from(b64, 'base64')));
  log(`screenshot (before freeze) -> ${path.join(work, 'before.png')}`);

  console.log('\n=== Act 3: freeze the WHOLE VM — Android becomes a directory ===');
  await vm.writeFile('/sbin/machinen-vmstate-reseed', RESEED_SHIM, { mode: 0o755 });
  t0 = Date.now();
  // Snapshot through an attach() handle (boot-owned handles deadlock under
  // the CRIU engine — same workaround as the machinen driver).
  const snapVm = await runtime.attach({ pid: vm.pid });
  await snapVm.snapshot({ outDir: snapDir, timeoutMs: 300_000 });
  timings.snapshot = Date.now() - t0;
  log(`whole-VM vmstate bundle -> ${snapDir} (${timings.snapshot}ms)`);

  await vm.kill();
  vm = undefined;
  log('source VM killed — the running Android device now exists ONLY in the bundle');

  console.log('\n=== Act 4: restore — the device never finds out ===');
  t0 = Date.now();
  restored = await runtime.restore({
    snapDir,
    kernel,
    ...(dtb ? { dtb } : {}),
    name: `android-restored-${process.pid}`,
    timeoutMs: 300_000,
  });
  timings.restore = Date.now() - t0;
  log(`restored as vmm pid ${restored.pid} (${timings.restore}ms)`);

  // The guest's adb server thaws with the VM, but its TCP session can come
  // back stale ("device offline") — a disconnect/reconnect always recovers.
  await execRetry(
    restored,
    `adb disconnect 127.0.0.1:${ADB_FWD} >/dev/null 2>&1; ` +
      `adb connect 127.0.0.1:${ADB_FWD} >/dev/null 2>&1; sleep 1; ` +
      `adb devices | grep '127.0.0.1:${ADB_FWD}' | grep -qw device && echo online`,
    'adb back online',
  );
  const after = (await execRetry(restored, STATE_CMD, 'post-restore state')).split('\n').map((s) => s.trim());
  log(`after restore: pid=${after[0]} boot_id=${after[1]} uptime=${after[2].split(' ')[0]}s`);
  await execRetry(
    restored,
    `${ADB} shell screencap -p /sdcard/shot2.png && ${ADB} pull /sdcard/shot2.png /root/s2.png >/dev/null && base64 /root/s2.png | tr -d '\\n'`,
    'screenshot after',
  ).then((b64) => writeFile(path.join(work, 'after.png'), Buffer.from(b64, 'base64')));
  log(`screenshot (after resume) -> ${path.join(work, 'after.png')}`);

  const pidSame = after[0] === before[0];
  const bootIdSame = after[1] === before[1];
  const uptimeGrew = parseFloat(after[2]) > parseFloat(before[2]);
  if (!(pidSame && bootIdSame && uptimeGrew)) {
    throw new Error(
      `the device did NOT resume seamlessly: pidSame=${pidSame} bootIdSame=${bootIdSame} uptimeGrew=${uptimeGrew}`,
    );
  }

  console.log('\n=== Verdict ===');
  console.log(`  app pid unchanged (${after[0]}), kernel boot_id unchanged, uptime continued`);
  console.log(`  ${parseFloat(before[2])}s -> ${parseFloat(after[2])}s across its own nonexistence.`);
  console.log('  An entire operating system — kernel, window manager, app, adb TCP mesh — was');
  console.log('  frozen mid-frame and thawed in a different VM. The app never noticed.');
  console.log(
    `  timings: outer boot ${timings.outerBoot}ms, tools ${timings.tools}ms, iso ${timings.iso}ms, ` +
      `android boot ${timings.androidBoot}ms, freeze ${timings.snapshot}ms, restore ${timings.restore}ms`,
  );
  console.log(`  screenshots kept in ${work} (before.png / after.png)`);
} finally {
  await vm?.kill().catch(() => {});
  await restored?.kill().catch(() => {});
  // Reclaim the ~1.9 GiB bundle; keep the screenshots as the evidence.
  await rm(snapDir, { recursive: true, force: true });
}
