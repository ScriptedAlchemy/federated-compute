// Analytics machine — guest AND consumer: it serves the protocol while
// querying db_machine through federation bindings resolved to a same-region
// (local) address.
import { createGuestRuntime, serveGuest } from '@federated-compute/machinen-plugin/guest';
import { createMachines } from '@federated-compute/machinen-plugin/client';

const machines = createMachines();
const db = machines.machine('db_machine').db;

async function topSpenders(limit = 5) {
  const start = performance.now();
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
serveGuest(guest, { port }).then((server) => {
  console.log(`[machine-analytics] analytics machine listening on 127.0.0.1:${server.port}`);
});
