import { createGuestRuntime, serveGuest } from '@federated-compute/machinen-plugin/guest';
import { exposes, state } from './exposes';

const port = Number(process.env.PORT ?? 3801);
// Loopback by default; set HOST=0.0.0.0 when running inside a real machinen
// VM so the gvproxy port-forward can reach the server from the host.
const hostname = process.env.HOST ?? '127.0.0.1';

const guest = createGuestRuntime({ name: 'compute_machine', version: '1.0.0', exposes, state });

serveGuest(guest, { port, hostname }).then((server) => {
  console.log(`[remote] machine guest listening on ${hostname}:${server.port}`);

  const shutdown = async (signal: string) => {
    console.log(`[remote] ${signal} received, shutting down gracefully`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
});
