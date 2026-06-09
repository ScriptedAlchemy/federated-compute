import { createInstance } from '@module-federation/runtime';
import { httpAttachDriver, machinenPlugin } from '@federated-compute/machinen-plugin';
import type { ComputeMachineModules } from './generated/compute_machine';
import type { JavaMachineModules } from './generated/java_machine';
import type { PythonMachineModules } from './generated/python_machine';

// Containment: each machine is somebody else's deployment (its own repo, its
// own host). This app only knows addresses — federation entries are the
// multiplexer and transport. Entries pin a semver range of the machine's API,
// negotiated against the machine manifest exactly like MF requiredVersion.
const token = process.env.MACHINEN_TOKEN;
const entry = (envVar: string, fallback: string) => {
  const base = process.env[envVar] ?? fallback;
  const params = new URLSearchParams({ version: '^1.0.0' });
  if (token) params.set('token', token);
  return `${base}?${params}`;
};

async function main() {
  const plugin = machinenPlugin({
    driver: httpAttachDriver(),
    restartOnCrash: true,
    calls: {
      timeoutMs: 10_000,
      retries: 2,
      backoffMs: 100,
      circuitBreaker: { threshold: 5, resetMs: 10_000 },
    },
  });

  plugin.machineHooks.onMachineReady.on(({ spec }) => {
    console.log(`[host] attached to machine "${spec.remoteName}" at ${spec.url}`);
  });
  plugin.machineHooks.onMachineCrash.on(({ spec }) => {
    console.error(`[host] !! machine "${spec.remoteName}" became unreachable`);
  });
  plugin.machineHooks.onCircuitOpen.on(({ spec }) => {
    console.error(`[host] !! circuit open for "${spec.remoteName}" — failing fast`);
  });

  const host = createInstance({
    name: 'host',
    remotes: [
      { name: 'compute_machine', entry: entry('COMPUTE_MACHINE', 'machinen+http://127.0.0.1:3801') },
      { name: 'java_machine', entry: entry('JAVA_MACHINE', 'machinen+http://127.0.0.1:3802') },
    ],
    plugins: [plugin],
  });

  // MF parity: machines can join at runtime via the standard registerRemotes.
  host.registerRemotes([
    { name: 'python_machine', entry: entry('PYTHON_MACHINE', 'machinen+http://127.0.0.1:3803') },
  ]);

  // Preload analog: attach + manifest-validate every machine before traffic.
  await plugin.warm();

  // From here on it feels like importing modules from one app — but every
  // call crosses into a machine, and the types come from machine manifests
  // via bindgen instead of being hand-written.
  const math = await host.loadRemote<ComputeMachineModules['./math']>('compute_machine/math');
  const text = await host.loadRemote<ComputeMachineModules['./text']>('compute_machine/text');
  const strings = await host.loadRemote<JavaMachineModules['./strings']>('java_machine/strings');
  const compute = await host.loadRemote<JavaMachineModules['./compute']>('java_machine/compute');
  const stats = await host.loadRemote<PythonMachineModules['./stats']>('python_machine/stats');
  const data = await host.loadRemote<PythonMachineModules['./data']>('python_machine/data');

  const [sum, fib20, shouted] = await Promise.all([
    math!.add(20, 22),
    math!.fib(20),
    text!.shout('federated compute'),
  ]);

  // Streaming binding: an async iterable crossing the machine boundary.
  const ticks: number[] = [];
  for await (const n of math!.countdown(3)) ticks.push(n);

  const [upper, digest, primes] = await Promise.all([
    strings!.upper('java says hello'),
    strings!.sha256('federated compute'),
    compute!.primesBelow(30),
  ]);

  const samples = [4, 8, 15, 16, 23, 42];
  const [mean, median, counts] = await Promise.all([
    stats!.mean(samples),
    stats!.median(samples),
    data!.wordCount('boot once run everywhere boot once'),
  ]);

  console.log('\n[host] results:');
  console.log(`  node   add(20, 22)        = ${sum}`);
  console.log(`  node   fib(20)            = ${fib20}`);
  console.log(`  node   shout(...)         = ${shouted}`);
  console.log(`  node   countdown stream   = ${ticks.join(' → ')}`);
  console.log(`  java   upper(...)         = ${upper}`);
  console.log(`  java   sha256(...)        = ${digest.slice(0, 16)}...`);
  console.log(`  java   primesBelow(30)    = ${primes.join(', ')}`);
  console.log(`  python mean / median      = ${mean} / ${median}`);
  console.log(`  python wordCount(...)     = ${JSON.stringify(counts)}`);

  console.log('\n[host] machine metrics:');
  for (const [name, m] of Object.entries(plugin.metrics())) {
    console.log(
      `  ${name}: calls=${m.calls} errors=${m.errors} crashes=${m.crashes} retries=${m.retries} p50=${m.p50Ms.toFixed(1)}ms p95=${m.p95Ms.toFixed(1)}ms`,
    );
  }

  console.log('\n[host] all machines reached through federation entries only — bye');
}

main().catch((error) => {
  console.error('[host] fatal:', error);
  process.exit(1);
});
