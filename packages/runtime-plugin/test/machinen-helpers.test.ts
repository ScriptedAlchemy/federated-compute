import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { parseMachineEntry, type MachineSpec } from '../src/types.js';

type MachinenModule = typeof import('../src/drivers/machinen.js');

const tempDirs: string[] = [];
const servers: http.Server[] = [];

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

async function writeSnapshotBundle(guestPort: number): Promise<string> {
  const dir = await tempDir('machinen-helpers-snapshot-');
  await writeFile(path.join(dir, 'meta.json'), '{}\n');
  await writeFile(path.join(dir, 'state.vmstate'), '');
  await writeFile(
    path.join(dir, 'federated-machine.json'),
    JSON.stringify({
      remoteName: 'vm_machine',
      guestPort,
      image: '/base/rootfs.tar',
      snappedAt: '2026-06-10T00:00:00.000Z',
    }),
  );
  return dir;
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
    await expect(loadRuntime()).rejects.toThrow(/pnpm add @machinen\/runtime@0\.4\.0 @machinen\/cli@0\.4\.0/s);
    await expect(loadRuntime()).rejects.toThrow(/pnpm exec machinen install/s);
  });
});

describe('Machinen driver unit behavior without KVM', () => {
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
      resolveBaseKernel: () => '/base/kernel',
      resolveBaseDtb: () => undefined,
    }));

    const { machinenDriver } = await importMachinen();
    const snapshotDir = await tempDir('machinen-helpers-output-');
    const sourceSnap = await writeSnapshotBundle(4707);
    const driver = machinenDriver({ snapshotDir, guestReadyTimeoutMs: 1_000 });
    const handle = await driver.boot(parseMachineEntry('vm_machine', `machinen://${sourceSnap}`));

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
    };
    expect(marker.guestPort).toBe(4707);
    expect(existsSync(path.join(snap.snapDir, 'state.vmstate'))).toBe(true);
    await handle.dispose?.();
  });
});
