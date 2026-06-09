import { createInstance } from '@module-federation/runtime';
import { httpAttachDriver, machinenPlugin } from '@federated-compute/machinen-plugin';
import type { ComputeMachineModules } from './generated/compute_machine';
import type { JavaMachineModules } from './generated/java_machine';
import type { PythonMachineModules } from './generated/python_machine';

// Containment: each machine is somebody else's deployment (its own repo, its
// own host). This app only knows addresses — federation entries are the
// multiplexer and transport. No machine source is ever referenced here.
const token = process.env.MACHINEN_TOKEN;
const entry = (envVar: string, fallback: string) => {
  const base = process.env[envVar] ?? fallback;
  return token ? `${base}?token=${token}` : base;
};

async function main() {
  const plugin = machinenPlugin({ driver: httpAttachDriver(), restartOnCrash: true });

  plugin.machineHooks.onMachineReady.on(({ spec }) => {
    console.log(`[host] attached to machine "${spec.remoteName}" at ${spec.url}`);
  });
  plugin.machineHooks.beforeCall.on(({ module, fn, args }) => {
    console.log(`[host] -> ${module}#${fn}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
  });
  plugin.machineHooks.afterCall.on(({ module, fn, result, durationMs }) => {
    console.log(
      `[host] <- ${module}#${fn} = ${JSON.stringify(result)} (${durationMs.toFixed(1)}ms)`,
    );
  });
  plugin.machineHooks.onMachineError.on(({ module, fn, error }) => {
    console.error(`[host] !! ${module}#${fn} failed:`, (error as Error).message);
  });
  plugin.machineHooks.onMachineCrash.on(({ spec }) => {
    console.error(`[host] !! machine "${spec.remoteName}" became unreachable`);
  });

  const host = createInstance({
    name: 'host',
    remotes: [
      { name: 'compute_machine', entry: entry('COMPUTE_MACHINE', 'machinen+http://127.0.0.1:3801') },
      { name: 'java_machine', entry: entry('JAVA_MACHINE', 'machinen+http://127.0.0.1:3802') },
      { name: 'python_machine', entry: entry('PYTHON_MACHINE', 'machinen+http://127.0.0.1:3803') },
    ],
    plugins: [plugin],
  });

  // From here on it feels like importing modules from one app — but every
  // call crosses into a machine, and the types come from machine manifests
  // via bindgen instead of being hand-written.
  const math = await host.loadRemote<ComputeMachineModules['./math']>('compute_machine/math');
  const text = await host.loadRemote<ComputeMachineModules['./text']>('compute_machine/text');
  const system = await host.loadRemote<ComputeMachineModules['./system']>(
    'compute_machine/system',
  );
  const strings = await host.loadRemote<JavaMachineModules['./strings']>('java_machine/strings');
  const compute = await host.loadRemote<JavaMachineModules['./compute']>('java_machine/compute');
  const jvm = await host.loadRemote<JavaMachineModules['./jvm']>('java_machine/jvm');
  const stats = await host.loadRemote<PythonMachineModules['./stats']>('python_machine/stats');
  const data = await host.loadRemote<PythonMachineModules['./data']>('python_machine/data');
  const python = await host.loadRemote<PythonMachineModules['./python']>(
    'python_machine/python',
  );

  const sum = await math!.add(20, 22);
  const fib20 = await math!.fib(20);
  const shouted = await text!.shout('federated compute');
  const machineInfo = await system!.whereAmI();

  // Streaming binding: an async iterable crossing the machine boundary.
  const ticks: number[] = [];
  for await (const n of math!.countdown(3)) ticks.push(n);

  const upper = await strings!.upper('java says hello');
  const digest = await strings!.sha256('federated compute');
  const primes = await compute!.primesBelow(30);
  const jvmInfo = await jvm!.info();

  const samples = [4, 8, 15, 16, 23, 42];
  const mean = await stats!.mean(samples);
  const median = await stats!.median(samples);
  const counts = await data!.wordCount('boot once run everywhere boot once');
  const pyInfo = await python!.info();

  console.log('\n[host] results from node machine:');
  console.log(`  add(20, 22)            = ${sum}`);
  console.log(`  fib(20)                = ${fib20}`);
  console.log(`  shout(...)             = ${shouted}`);
  console.log(`  countdown(3) stream    = ${ticks.join(' → ')}`);
  console.log(`  machine pid            = ${machineInfo.pid} (host pid ${process.pid})`);

  console.log('\n[host] results from java machine:');
  console.log(`  upper(...)             = ${upper}`);
  console.log(`  sha256(...)            = ${digest.slice(0, 16)}...`);
  console.log(`  primesBelow(30)        = ${primes.join(', ')}`);
  console.log(`  jvm pid                = ${jvmInfo.pid} on Java ${jvmInfo.javaVersion}`);

  console.log('\n[host] results from python machine:');
  console.log(`  mean([4,8,15,16,23,42])   = ${mean}`);
  console.log(`  median([4,8,15,16,23,42]) = ${median}`);
  console.log(`  wordCount(...)            = ${JSON.stringify(counts)}`);
  console.log(`  python pid                = ${pyInfo.pid} on Python ${pyInfo.pythonVersion}`);

  console.log('\n[host] all machines reached through federation entries only — bye');
}

main().catch((error) => {
  console.error('[host] fatal:', error);
  process.exit(1);
});
