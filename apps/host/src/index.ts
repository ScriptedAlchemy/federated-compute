// End-user view: machine functions are just imports. Addresses resolve
// invisibly from MACHINEN_REMOTE_* env vars; the federation instance,
// driver, retries, circuit breaker, and version negotiation all live
// behind these imports.
import { math, text, strings, compute, stats, data } from './generated';
import {
  httpAttachDriver,
  machinenDriver,
  type MachineDriver,
  type MachineSpec,
} from '@federated-compute/machinen-plugin';
import { configureMachines, getMachines } from '@federated-compute/machinen-plugin/client';

function mixedDriver(): MachineDriver {
  const attach = httpAttachDriver();
  const vm = machinenDriver({ bootTimeoutMs: 180_000 });
  return {
    boot(spec: MachineSpec) {
      return spec.kind === 'attach' ? attach.boot(spec) : vm.boot(spec);
    },
  };
}

configureMachines({ driver: mixedDriver(), bootTimeoutMs: 180_000 });

async function main() {
  try {
    const sum = await math.add(20, 22);
    const fib20 = await math.fib(20);
    const shouted = await text.shout('federated compute');

    const ticks: number[] = [];
    for await (const n of math.countdown(3)) ticks.push(n);

    const upper = await strings.upper('java says hello');
    const digest = await strings.sha256('federated compute');
    const primes = await compute.primesBelow(30);

    const samples = [4, 8, 15, 16, 23, 42];
    const mean = await stats.mean(samples);
    const median = await stats.median(samples);
    const counts = await data.wordCount('boot once run everywhere boot once');

    console.log('[host] results:');
    console.log(`  node   add(20, 22)        = ${sum}`);
    console.log(`  node   fib(20)            = ${fib20}`);
    console.log(`  node   shout(...)         = ${shouted}`);
    console.log(`  node   countdown stream   = ${ticks.join(' → ')}`);
    console.log(`  java   upper(...)         = ${upper}`);
    console.log(`  java   sha256(...)        = ${digest.slice(0, 16)}...`);
    console.log(`  java   primesBelow(30)    = ${primes.join(', ')}`);
    console.log(`  python mean / median      = ${mean} / ${median}`);
    console.log(`  python wordCount(...)     = ${JSON.stringify(counts)}`);

    // Operators can still reach the full surface (hooks, warm, snapshot/fork).
    console.log('\n[host] machine metrics:');
    for (const [name, m] of Object.entries(getMachines().metrics())) {
      console.log(
        `  ${name}: calls=${m.calls} errors=${m.errors} crashes=${m.crashes} p50=${m.p50Ms.toFixed(1)}ms p95=${m.p95Ms.toFixed(1)}ms`,
      );
    }
  } finally {
    await getMachines().plugin.disposeMachines();
  }
}

main().catch((error) => {
  console.error('[host] fatal:', error);
  process.exit(1);
});
