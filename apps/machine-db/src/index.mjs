// Database machine — hosted "in eu-west". Plain Node, no bundler: guests are
// just processes that speak the protocol.
import { createGuestRuntime, serveGuest } from '@federated-compute/machinen-plugin/guest';

// Deterministic dataset (tiny LCG so every boot serves identical data).
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

const FIRST = ['Ada', 'Linus', 'Grace', 'Edsger', 'Barbara', 'Donald', 'Margaret', 'Alan', 'Radia', 'Ken', 'Frances', 'Dennis'];
const LAST = ['Hopper', 'Torvalds', 'Lovelace', 'Dijkstra', 'Liskov', 'Knuth', 'Hamilton', 'Kay', 'Perlman', 'Thompson', 'Allen', 'Ritchie'];

const users = Array.from({ length: 24 }, (_, i) => ({
  id: i + 1,
  name: `${FIRST[i % FIRST.length]} ${LAST[Math.floor(rand() * LAST.length)]}`,
  plan: rand() > 0.6 ? 'pro' : 'free',
}));

const orders = new Map(
  users.map((user) => [
    user.id,
    Array.from({ length: 2 + Math.floor(rand() * 7) }, (_, n) => ({
      id: `${user.id}-${n + 1}`,
      amount: Math.round(rand() * 24000) / 100,
    })),
  ]),
);

const guest = createGuestRuntime({
  name: 'db_machine',
  version: '1.0.0',
  exposes: {
    './db': {
      listUsers: {
        handler: () => users,
        params: [],
        returns: '{ id: number; name: string; plan: string }[]',
      },
      ordersFor: {
        handler: (userId) => orders.get(userId) ?? [],
        params: [{ name: 'userId', type: 'number' }],
        returns: '{ id: string; amount: number }[]',
      },
    },
  },
});

const port = Number(process.env.PORT ?? 3804);
const token = process.env.MACHINEN_TOKEN || undefined;
serveGuest(guest, { port, token }).then((server) => {
  console.log(`[machine-db] database machine listening on 127.0.0.1:${server.port}`);
});
