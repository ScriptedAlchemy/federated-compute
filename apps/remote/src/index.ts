import { createGuestRuntime, serveGuest } from '@federated-compute/machinen-plugin/guest';
import { exposes } from './exposes';

const port = Number(process.env.PORT ?? 3801);
const token = process.env.MACHINEN_TOKEN || undefined;

const guest = createGuestRuntime({ name: 'compute_machine', exposes });

serveGuest(guest, { port, token }).then((server) => {
  console.log(`[remote] machine guest listening on 127.0.0.1:${server.port}`);
});
