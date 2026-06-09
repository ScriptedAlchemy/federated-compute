// Analytics machine — "the code that moved to the data". It is BOTH a guest
// (serves the protocol to consumers) and a consumer (uses federation bindings
// to query db_machine, which sits in the same region: its MACHINEN_REMOTE_DB_MACHINE
// points at the LOCAL address, no WAN in between).
import { createGuestRuntime, serveGuest } from '@federated-compute/machinen-plugin/guest';
import { createMachines } from '@federated-compute/machinen-plugin/client';

const machines = createMachines();
const db = machines.machine('db_machine').db;

async function topSpenders(limit = 5) {
  const start = performance.now();
  // The exact same N+1 the consumer would run — but here every query is a
  // same-region hop instead of a WAN round-trip.
  const users = await db.listUsers();
  let queries = 1;
  const totals = [];
  for (const user of users) {
    const orders = await db.ordersFor(user.id);
    queries++;
    totals.push({
      name: user.name,
      plan: user.plan,
      total: Math.round(orders.reduce((sum, o) => sum + o.amount, 0) * 100) / 100,
    });
  }
  totals.sort((a, b) => b.total - a.total);
  return {
    spenders: totals.slice(0, Math.max(1, Math.min(Number(limit) || 5, 10))),
    queries,
    dbMs: Math.round((performance.now() - start) * 10) / 10,
  };
}

const guest = createGuestRuntime({
  name: 'analytics_machine',
  version: '1.0.0',
  exposes: {
    './analytics': {
      topSpenders: {
        handler: topSpenders,
        params: [{ name: 'limit', type: 'number' }],
        returns:
          '{ spenders: { name: string; plan: string; total: number }[]; queries: number; dbMs: number }',
      },
    },
  },
});

const port = Number(process.env.PORT ?? 3805);
const token = process.env.MACHINEN_TOKEN || undefined;
serveGuest(guest, { port, token }).then((server) => {
  console.log(`[machine-analytics] analytics machine listening on 127.0.0.1:${server.port}`);
});
