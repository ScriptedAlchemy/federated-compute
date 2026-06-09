import { createGuestRuntime, serveGuest } from '@federated-compute/machinen-plugin/guest';
import { exposes } from './exposes';

const port = Number(process.env.PORT ?? 3801);
const token = process.env.MACHINEN_TOKEN || undefined;

const guest = createGuestRuntime({ name: 'compute_machine', version: '1.0.0', exposes });

serveGuest(guest, { port, token }).then((server) => {
  console.log(`[remote] machine guest listening on 127.0.0.1:${server.port}`);

  const shutdown = async (signal: string) => {
    console.log(`[remote] ${signal} received, shutting down gracefully`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
});
