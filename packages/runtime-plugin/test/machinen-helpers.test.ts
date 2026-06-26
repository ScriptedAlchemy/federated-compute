import http from 'node:http';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { parseMachineEntry, type MachineSpec } from '../src/types.js';

type MachinenModule = typeof import('../src/drivers/machinen.js');
const SHELL = {
  rootfsDigest: `sha256:${'1'.repeat(64)}`,
  kernelDigest: `sha256:${'2'.repeat(64)}`,
};

const tempDirs: string[] = [];
const servers: http.Server[] = [];

function digest(bytes: string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeGuestBundle(): Promise<string> {
  const dir = await tempDir('machinen-helpers-bundle-');
  const file = path.join(dir, 'guest.mjs');
  await writeFile(file, 'export {};\n');
  return file;
}

async function writeGuestJar(): Promise<string> {
  const dir = await tempDir('machinen-helpers-jar-');
  const file = path.join(dir, 'java-machine.jar');
  await writeFile(file, 'jar bytes\n');
  await writeFile(path.join(dir, 'mf-types.ts'), 'export interface JavaMachine {}\n');
  return file;
}

async function writeJavaMachineImage(): Promise<string> {
  const dir = await tempDir('machinen-helpers-java-machine-');
  await writeFile(path.join(dir, 'guest.jar'), 'jar bytes\n');
  await writeFile(path.join(dir, 'mf-types.ts'), 'export interface JavaMachine {}\n');
  await writeFile(
    path.join(dir, 'machinen-machine.json'),
    JSON.stringify({
      format: 'machinen-machine@1',
      runtime: 'java',
      program: 'guest.jar',
      types: 'mf-types.ts',
      rootDiskSizeBytes: 4 * 1024 ** 3,
    }),
  );
  return dir;
}

async function writeSnapshotBundle(
  guestPort: number,
  shell?: typeof SHELL,
): Promise<{ dir: string; image: string; kernel: string; shell: typeof SHELL }> {
  const dir = await tempDir('machinen-helpers-snapshot-');
  const image = path.join(dir, 'rootfs.tar');
  const kernel = path.join(dir, 'kernel');
  await writeFile(image, 'rootfs bytes');
  await writeFile(kernel, 'kernel bytes');
  const markerShell = shell ?? {
    rootfsDigest: digest('rootfs bytes'),
    kernelDigest: digest('kernel bytes'),
  };
  await writeFile(path.join(dir, 'meta.json'), '{}\n');
  await writeFile(path.join(dir, 'state.vmstate'), '');
  await writeFile(
    path.join(dir, 'federated-machine.json'),
    JSON.stringify({
      remoteName: 'vm_machine',
      guestPort,
      image,
      shell: markerShell,
      snappedAt: '2026-06-10T00:00:00.000Z',
    }),
  );
  return { dir, image, kernel, shell: markerShell };
}

async function startHealthServer(port: number): Promise<void> {
  const server = http.createServer((req, res) => {
    if (req.url === '/mf/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: 'vm_machine' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
}

async function importMachinen(): Promise<MachinenModule> {
  return await import('../src/drivers/machinen.js');
}

afterEach(async () => {
  vi.doUnmock('@machinen/runtime');
  vi.doUnmock('node:child_process');
  vi.resetModules();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Machinen pure helpers', () => {
  test('shellSingleQuote preserves shell metacharacters inside one literal argument', async () => {
    const { shellSingleQuote } = await importMachinen();

    expect(shellSingleQuote('plain-value')).toBe("'plain-value'");
    expect(shellSingleQuote("tok'en")).toBe("'tok'\\''en'");
    expect(shellSingleQuote('$(touch /tmp/pwn)')).toBe("'$(touch /tmp/pwn)'");
    expect(shellSingleQuote('`touch /tmp/pwn`')).toBe("'`touch /tmp/pwn`'");
    expect(shellSingleQuote('back\\slash')).toBe("'back\\slash'");
    expect(shellSingleQuote('line1\nline2')).toBe("'line1\nline2'");
  });

  test('isMachinenSnapshotDir requires both machinen bundle markers', async () => {
    const { isMachinenSnapshotDir } = await importMachinen();
    const dir = await tempDir('machinen-helpers-markers-');

    expect(await isMachinenSnapshotDir(path.join(dir, 'missing'))).toBe(false);
    expect(await isMachinenSnapshotDir(dir)).toBe(false);

    await writeFile(path.join(dir, 'meta.json'), '{}\n');
    expect(await isMachinenSnapshotDir(dir)).toBe(false);

    await rm(path.join(dir, 'meta.json'));
    await writeFile(path.join(dir, 'state.vmstate'), '');
    expect(await isMachinenSnapshotDir(dir)).toBe(false);

    await writeFile(path.join(dir, 'meta.json'), '{}\n');
    expect(await isMachinenSnapshotDir(dir)).toBe(true);
  });

  test('guestPortFor reads the port param and defaults to the guest protocol port', async () => {
    const { guestPortFor } = await importMachinen();

    expect(guestPortFor(parseMachineEntry('vm_machine', 'machinen:///tmp/guest.mjs'))).toBe(3801);
    expect(guestPortFor(parseMachineEntry('vm_machine', 'machinen:///tmp/guest.mjs?port=4707'))).toBe(4707);
  });

  test('resolved guest port prefers the snapshot marker for chained restores', async () => {
    const { guestPortFor, resolveGuestPort } = await importMachinen();
    const spec = parseMachineEntry('vm_machine', 'machinen:///tmp/restored-snapshot');

    expect(guestPortFor(spec)).toBe(3801);
    expect(resolveGuestPort(spec, { guestPort: 4707 })).toBe(4707);
  });

  test('machinenDriver rejects non-image entries before loading the optional runtime', async () => {
    const { machinenDriver } = await importMachinen();
    const attachSpec: MachineSpec = {
      remoteName: 'vm_machine',
      entry: 'machinen+http://127.0.0.1:3801',
      kind: 'attach',
      url: 'http://127.0.0.1:3801',
      params: new URLSearchParams(),
    };

    await expect(machinenDriver().boot(attachSpec)).rejects.toThrow(/expects a machinen:\/\/<image> entry/);
  });

  test('loadRuntime reports the missing optional peer with install guidance', async () => {
    vi.doMock('@machinen/runtime', () => {
      throw new Error('Cannot find package @machinen/runtime');
    });
    const { loadRuntime } = await importMachinen();

    await expect(loadRuntime()).rejects.toThrow(/optional peer dependency.*@machinen\/runtime/s);
    await expect(loadRuntime()).rejects.toThrow(/pnpm add @machinen\/runtime@0\.6\.1 @machinen\/cli@0\.6\.1/s);
    await expect(loadRuntime()).rejects.toThrow(/pnpm exec machinen install/s);
  });
});

describe('Machinen driver unit behavior without KVM', () => {
  test('fresh boot provisions missing base assets through the MachineN CLI and retries resolution', async () => {
    const projectRoot = await tempDir('machinen-helpers-project-');
    const cliBin = '/opt/machinen/bin/machinen';
    const missing = Object.assign(new Error('base rootfs missing'), { code: 'PROVISION_BASE_NOT_FOUND' });
    const resolveBaseRootfs = vi
      .fn()
      .mockImplementationOnce(() => {
        throw missing;
      })
      .mockReturnValue('/base/rootfs.tar');
    const bootCalls: Record<string, unknown>[] = [];
    const logs: string[] = [];
    const vm = {
      pid: 1,
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
      writeFile: vi.fn(),
      snapshot: vi.fn(),
      kill: vi.fn(async () => {}),
    };
    const spawnMock = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('{"fetched":true}\n'));
        child.emit('exit', 0, null);
      });
      return child;
    });

    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));
    vi.doMock('@machinen/runtime', () => ({
      boot: vi.fn(async (opts: Record<string, unknown>) => {
        bootCalls.push(opts);
        const [{ hostPort }] = opts.portForward as Array<{ hostPort: number; guestPort: number }>;
        await startHealthServer(hostPort);
        return vm;
      }),
      restore: vi.fn(),
      resolveBaseRootfs,
      resolveBaseKernel: () => '/base/kernel',
      resolveBaseDtb: () => undefined,
    }));

    const { machinenDriver } = await importMachinen();
    const driver = machinenDriver({
      guestReadyTimeoutMs: 1_000,
      log: (line) => logs.push(line),
      machinenCliBin: cliBin,
      projectRoot,
    });
    const handle = await driver.boot(parseMachineEntry('vm_machine', `machinen://${await writeGuestBundle()}`));

    expect(resolveBaseRootfs).toHaveBeenCalledTimes(2);
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [cliBin, 'install', '--json'],
      expect.objectContaining({ cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] }),
    );
    expect(resolveBaseRootfs.mock.invocationCallOrder[0]).toBeLessThan(spawnMock.mock.invocationCallOrder[0]);
    expect(spawnMock.mock.invocationCallOrder[0]).toBeLessThan(resolveBaseRootfs.mock.invocationCallOrder[1]);
    expect(bootCalls[0].image).toBe('/base/rootfs.tar');
    expect(logs.some((line) => line.includes('base assets missing'))).toBe(true);
    await handle.dispose?.();
  });

  test('fresh boot can use an injected programmatic base asset provisioner', async () => {
    const missing = Object.assign(new Error('base rootfs missing'), { code: 'PROVISION_BASE_NOT_FOUND' });
    const resolveBaseRootfs = vi
      .fn()
      .mockImplementationOnce(() => {
        throw missing;
      })
      .mockReturnValue('/base/rootfs.tar');
    const provisioner = vi.fn();
    const spawnMock = vi.fn();
    const vm = {
      pid: 1,
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
      writeFile: vi.fn(),
      snapshot: vi.fn(),
      kill: vi.fn(async () => {}),
    };

    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));
    vi.doMock('@machinen/runtime', () => ({
      boot: vi.fn(async (opts: Record<string, unknown>) => {
        const [{ hostPort }] = opts.portForward as Array<{ hostPort: number; guestPort: number }>;
        await startHealthServer(hostPort);
        return vm;
      }),
      restore: vi.fn(),
      resolveBaseRootfs,
      resolveBaseKernel: () => '/base/kernel',
      resolveBaseDtb: () => undefined,
    }));

    const { machinenDriver } = await importMachinen();
    const driver = machinenDriver({
      baseAssetProvisioner: provisioner,
      assetProvisionTimeoutMs: 1234,
      guestReadyTimeoutMs: 1_000,
    });
    const handle = await driver.boot(parseMachineEntry('vm_machine', `machinen://${await writeGuestBundle()}`));

    expect(provisioner).toHaveBeenCalledWith({
      timeoutMs: 1234,
      log: expect.any(Function),
    });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(resolveBaseRootfs).toHaveBeenCalledTimes(2);
    await handle.dispose?.();
  });

  test('fresh boot can disable automatic base asset provisioning', async () => {
    const missing = Object.assign(new Error('base rootfs missing'), { code: 'PROVISION_BASE_NOT_FOUND' });
    const spawnMock = vi.fn();
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));
    vi.doMock('@machinen/runtime', () => ({
      boot: vi.fn(),
      restore: vi.fn(),
      resolveBaseRootfs: () => {
        throw missing;
      },
      resolveBaseKernel: () => '/base/kernel',
      resolveBaseDtb: () => undefined,
    }));

    const { machinenDriver } = await importMachinen();

    await expect(
      machinenDriver({ autoProvisionBaseAssets: false }).boot(
        parseMachineEntry('vm_machine', `machinen://${await writeGuestBundle()}`),
      ),
    ).rejects.toThrow(/base rootfs missing/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test('fresh boot uses a finite boot timeout and stores the launcher as owner-only', async () => {
    const bootCalls: Record<string, unknown>[] = [];
    const writes: Array<{ guestPath: string; mode?: number; contents: string | Buffer }> = [];
    const vm = {
      pid: 1,
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
      writeFile: vi.fn(async (guestPath: string, contents: string | Buffer, opts?: { mode?: number }) => {
        writes.push({ guestPath, contents, mode: opts?.mode });
      }),
      snapshot: vi.fn(),
      kill: vi.fn(async () => {}),
    };

    vi.doMock('@machinen/runtime', () => ({
      boot: vi.fn(async (opts: Record<string, unknown>) => {
        bootCalls.push(opts);
        const [{ hostPort }] = opts.portForward as Array<{ hostPort: number; guestPort: number }>;
        await startHealthServer(hostPort);
        return vm;
      }),
      restore: vi.fn(),
      resolveBaseRootfs: () => '/base/rootfs.tar',
      resolveBaseKernel: () => '/base/kernel',
      resolveBaseDtb: () => undefined,
    }));

    const { machinenDriver } = await importMachinen();
    const driver = machinenDriver({ guestReadyTimeoutMs: 1_000 });
    const handle = await driver.boot(parseMachineEntry('vm_machine', `machinen://${await writeGuestBundle()}`));

    expect(bootCalls[0].timeoutMs).toBe(120_000);
    expect(writes.find((write) => write.guestPath === '/opt/federated/run.sh')?.mode).toBe(0o600);
    await handle.dispose?.();
  });

  test('direct jar entries are not Machinen machine images', async () => {
    const { machinenDriver } = await importMachinen();

    await expect(
      machinenDriver().boot(parseMachineEntry('java_machine', `machinen://${await writeGuestJar()}`)),
    ).rejects.toThrow(/machinen-machine@1 image directory/i);
  });

  test('java machine image installs a JRE, writes the jar payload and types artifact, and launches java', async () => {
    const bootCalls: Record<string, unknown>[] = [];
    const writes: Array<{ guestPath: string; mode?: number; contents: string | Buffer }> = [];
    const vm = {
      pid: 1,
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
      writeFile: vi.fn(async (guestPath: string, contents: string | Buffer, opts?: { mode?: number }) => {
        writes.push({ guestPath, contents, mode: opts?.mode });
      }),
      snapshot: vi.fn(),
      kill: vi.fn(async () => {}),
    };

    vi.doMock('@machinen/runtime', () => ({
      boot: vi.fn(async (opts: Record<string, unknown>) => {
        bootCalls.push(opts);
        const [{ hostPort }] = opts.portForward as Array<{ hostPort: number; guestPort: number }>;
        await startHealthServer(hostPort);
        return vm;
      }),
      restore: vi.fn(),
      resolveBaseRootfs: () => '/base/rootfs.tar',
      resolveBaseKernel: () => '/base/kernel',
      resolveBaseDtb: () => undefined,
    }));

    const { machinenDriver } = await importMachinen();
    const driver = machinenDriver({ guestReadyTimeoutMs: 1_000 });
    const handle = await driver.boot(parseMachineEntry('java_machine', `machinen://${await writeJavaMachineImage()}`));

    expect(bootCalls[0].rootDiskSizeBytes).toBe(4 * 1024 ** 3);
    expect(vm.exec).toHaveBeenCalledWith(
      expect.stringContaining(
        'DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends default-jre-headless ca-certificates </dev/null',
      ),
      { execTimeoutMs: 240_000 },
    );
    expect(vm.exec).toHaveBeenCalledWith(expect.stringContaining('mkdir -p /usr/share/man/man1'), {
      execTimeoutMs: 240_000,
    });
    expect(vm.exec).toHaveBeenCalledWith(expect.stringContaining('/var/log/apt/term.log'), {
      execTimeoutMs: 240_000,
    });
    expect(writes.find((write) => write.guestPath === '/opt/federated/guest.jar')?.contents).toEqual(
      Buffer.from('jar bytes\n'),
    );
    expect(writes.find((write) => write.guestPath === '/opt/federated/mf-types.ts')?.contents).toEqual(
      Buffer.from('export interface JavaMachine {}\n'),
    );
    const launcher = String(writes.find((write) => write.guestPath === '/opt/federated/run.sh')?.contents);
    expect(launcher).toContain("export HOST='0.0.0.0'");
    expect(launcher).toContain("export MACHINEN_TYPES_FILE='/opt/federated/mf-types.ts'");
    expect(launcher).toContain('exec java -jar /opt/federated/guest.jar');
    await handle.dispose?.();
  });

  test('java machine image boot accepts a root disk size override from the entry', async () => {
    const bootCalls: Record<string, unknown>[] = [];
    const vm = {
      pid: 1,
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
      writeFile: vi.fn(),
      snapshot: vi.fn(),
      kill: vi.fn(async () => {}),
    };

    vi.doMock('@machinen/runtime', () => ({
      boot: vi.fn(async (opts: Record<string, unknown>) => {
        bootCalls.push(opts);
        const [{ hostPort }] = opts.portForward as Array<{ hostPort: number; guestPort: number }>;
        await startHealthServer(hostPort);
        return vm;
      }),
      restore: vi.fn(),
      resolveBaseRootfs: () => '/base/rootfs.tar',
      resolveBaseKernel: () => '/base/kernel',
      resolveBaseDtb: () => undefined,
    }));

    const { machinenDriver } = await importMachinen();
    const driver = machinenDriver({ guestReadyTimeoutMs: 1_000 });
    const handle = await driver.boot(
      parseMachineEntry('java_machine', `machinen://${await writeJavaMachineImage()}?rootDiskSizeBytes=5368709120`),
    );

    expect(bootCalls[0].rootDiskSizeBytes).toBe(5 * 1024 ** 3);
    await handle.dispose?.();
  });

  test('invalid launcher env keys are rejected before boot', async () => {
    const { machinenDriver } = await importMachinen();

    expect(() => machinenDriver({ env: { 'BAD;touch /tmp/pwn': 'value' } })).toThrow(/invalid env key/i);
  });

  test('exec failures throw stderr and kill the VM instead of waiting for health', async () => {
    const vm = {
      pid: 1,
      exec: vi.fn().mockResolvedValueOnce({ exitCode: 100, stdout: '', stderr: 'apt mirror failed' }),
      writeFile: vi.fn(),
      snapshot: vi.fn(),
      kill: vi.fn(async () => {}),
    };
    vi.doMock('@machinen/runtime', () => ({
      boot: vi.fn(async () => vm),
      restore: vi.fn(),
      resolveBaseRootfs: () => '/base/rootfs.tar',
      resolveBaseKernel: () => '/base/kernel',
      resolveBaseDtb: () => undefined,
    }));

    const { machinenDriver } = await importMachinen();
    const driver = machinenDriver({ guestReadyTimeoutMs: 10 });

    await expect(driver.boot(parseMachineEntry('vm_machine', `machinen://${await writeGuestBundle()}`))).rejects.toThrow(
      /apt mirror failed/,
    );
    expect(vm.kill).toHaveBeenCalledTimes(1);
  });

  test('health timeout includes the guest log tail before killing the VM', async () => {
    const vm = {
      pid: 1,
      exec: vi
        .fn()
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'launcher stacktrace\n', stderr: '' }),
      writeFile: vi.fn(),
      snapshot: vi.fn(),
      kill: vi.fn(async () => {}),
    };
    vi.doMock('@machinen/runtime', () => ({
      boot: vi.fn(async () => vm),
      restore: vi.fn(),
      resolveBaseRootfs: () => '/base/rootfs.tar',
      resolveBaseKernel: () => '/base/kernel',
      resolveBaseDtb: () => undefined,
    }));

    const { machinenDriver } = await importMachinen();
    const driver = machinenDriver({ guestReadyTimeoutMs: 10 });

    await expect(driver.boot(parseMachineEntry('vm_machine', `machinen://${await writeGuestBundle()}`))).rejects.toThrow(
      /launcher stacktrace/,
    );
    expect(vm.exec).toHaveBeenLastCalledWith('tail -50 /var/log/federated-guest.log', { execTimeoutMs: 5_000 });
    expect(vm.kill).toHaveBeenCalledTimes(1);
  });

  test('direct snapshot restore rejects malformed shell markers before restore', async () => {
    const sourceSnap = await writeSnapshotBundle(4707);
    await writeFile(
      path.join(sourceSnap.dir, 'federated-machine.json'),
      JSON.stringify({
        remoteName: 'vm_machine',
        guestPort: 4707,
        image: sourceSnap.image,
        shell: {},
        snappedAt: '2026-06-10T00:00:00.000Z',
      }),
    );
    const restore = vi.fn();
    vi.doMock('@machinen/runtime', () => ({
      boot: vi.fn(),
      restore,
      resolveBaseRootfs: () => '/base/rootfs.tar',
      resolveBaseKernel: () => sourceSnap.kernel,
      resolveBaseDtb: () => undefined,
    }));

    const { machinenDriver } = await importMachinen();
    await expect(
      machinenDriver().boot(parseMachineEntry('vm_machine', `machinen://${sourceSnap.dir}`)),
    ).rejects.toThrow(/invalid MachineN shell marker/);
    expect(restore).not.toHaveBeenCalled();
  });

  test('direct snapshot restore rejects local shell mismatches before restore', async () => {
    const sourceSnap = await writeSnapshotBundle(4707);
    const otherKernel = path.join(await tempDir('machinen-helpers-other-kernel-'), 'kernel');
    await writeFile(otherKernel, 'different kernel bytes');
    const restore = vi.fn();
    vi.doMock('@machinen/runtime', () => ({
      boot: vi.fn(),
      restore,
      resolveBaseRootfs: () => '/base/rootfs.tar',
      resolveBaseKernel: () => otherKernel,
      resolveBaseDtb: () => undefined,
    }));

    const { machinenDriver } = await importMachinen();
    await expect(
      machinenDriver().boot(parseMachineEntry('vm_machine', `machinen://${sourceSnap.dir}`)),
    ).rejects.toThrow(/shell mismatch/);
    expect(restore).not.toHaveBeenCalled();
  });

  test('snapshotting a restored VM records the marker guest port used for restore', async () => {
    const restoreCalls: Record<string, unknown>[] = [];
    const vm = {
      pid: 1,
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
      writeFile: vi.fn(),
      snapshot: vi.fn(),
      kill: vi.fn(async () => {}),
    };
    // Snapshots must go through an attach() handle, never the boot-owned
    // one (the CRIU engine's snapshot path deadlocks on boot handles).
    const snapVm = {
      pid: 1,
      exec: vi.fn(),
      writeFile: vi.fn(),
      snapshot: vi.fn(async ({ outDir }: { outDir: string }) => {
        await mkdir(outDir, { recursive: true });
        await writeFile(path.join(outDir, 'meta.json'), '{}\n');
        await writeFile(path.join(outDir, 'state.vmstate'), '');
        return { snapDir: outDir, elapsedMs: 1 };
      }),
      kill: vi.fn(async () => {}),
    };
    const attach = vi.fn(async () => snapVm);
    const sourceSnap = await writeSnapshotBundle(4707);
    vi.doMock('@machinen/runtime', () => ({
      boot: vi.fn(),
      restore: vi.fn(async (opts: Record<string, unknown>) => {
        restoreCalls.push(opts);
        const [{ hostPort }] = opts.portForward as Array<{ hostPort: number; guestPort: number }>;
        await startHealthServer(hostPort);
        return vm;
      }),
      attach,
      resolveBaseRootfs: () => '/base/rootfs.tar',
      resolveBaseKernel: () => sourceSnap.kernel,
      resolveBaseDtb: () => undefined,
    }));

    const { machinenDriver } = await importMachinen();
    const snapshotDir = await tempDir('machinen-helpers-output-');
    const driver = machinenDriver({ snapshotDir, guestReadyTimeoutMs: 1_000 });
    const handle = await driver.boot(parseMachineEntry('vm_machine', `machinen://${sourceSnap.dir}`));

    expect((restoreCalls[0].portForward as Array<{ guestPort: number }>)[0].guestPort).toBe(4707);
    const snap = (await handle.snapshot?.()) as { snapDir: string };
    expect(attach).toHaveBeenCalledWith({ pid: vm.pid });
    expect(vm.snapshot).not.toHaveBeenCalled();
    expect(snapVm.snapshot).toHaveBeenCalledTimes(1);
    // The reseed shim is written through the live handle before the dump.
    expect(vm.writeFile).toHaveBeenCalledWith(
      '/sbin/machinen-vmstate-reseed',
      expect.stringContaining('/dev/urandom'),
      { mode: 0o755 },
    );
    const marker = JSON.parse(await readFile(path.join(snap.snapDir, 'federated-machine.json'), 'utf8')) as {
      guestPort: number;
      shell: typeof sourceSnap.shell;
    };
    expect(marker.guestPort).toBe(4707);
    expect(marker.shell).toEqual(sourceSnap.shell);
    expect(existsSync(path.join(snap.snapDir, 'state.vmstate'))).toBe(true);
    await handle.dispose?.();
  });
});
