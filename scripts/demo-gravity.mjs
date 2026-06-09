// Data gravity, CLI edition: the same report cross-region (N+1 over the WAN)
// vs co-located (one federated call to analytics_machine next to the db).
import { createMachines } from '../packages/runtime-plugin/dist/client.js';
import { startWanLinks } from './latency-proxy.mjs';
import { startMachines, wanEntry } from './machines.mjs';

const token = 'gravity-secret';
const REGION_LATENCY = Number(process.env.REGION_LATENCY ?? 75);

const { stop } = await startMachines({ token });
// Both paths into the data region cross the WAN — the difference is HOW OFTEN.
const wan = await startWanLinks({ latencyMs: REGION_LATENCY });

const machines = createMachines({
  token,
  remotes: {
    db_machine: wanEntry('db_machine'),
    analytics_machine: wanEntry('analytics_machine'),
  },
});
const db = machines.machine('db_machine').db;
const analytics = machines.machine('analytics_machine').analytics;

console.log(`\nregion latency: +${REGION_LATENCY}ms per request crossing the WAN\n`);

// Scenario 1: consumer queries the far database itself (sequential N+1).
let start = performance.now();
const users = await db.listUsers();
let queries = 1;
const totals = [];
for (const user of users) {
  const orders = await db.ordersFor(user.id);
  queries++;
  totals.push({
    name: user.name,
    plan: user.plan,
    total: orders.reduce((s, o) => s + o.amount, 0),
  });
}
totals.sort((a, b) => b.total - a.total);
const remoteMs = performance.now() - start;
console.log(`[cross-region] ${queries} queries, every one across the WAN`);
console.log(`[cross-region] total: ${remoteMs.toFixed(0)}ms\n`);

// Scenario 2: one federated call; the code already lives with the data.
start = performance.now();
const report = await analytics.topSpenders(5);
const coloMs = performance.now() - start;
console.log(`[co-located]   ${report.queries} queries inside the data region (${report.dbMs.toFixed(0)}ms)`);
console.log(`[co-located]   1 WAN crossing, total: ${coloMs.toFixed(0)}ms\n`);

console.log(`top spender either way: ${report.spenders[0].name} ($${report.spenders[0].total.toFixed(2)})`);
console.log(`\n→ ${(remoteMs / coloMs).toFixed(1)}x faster by moving the code to the data`);

await machines.plugin.disposeMachines();
await wan.close();
stop();
process.exit(0);
