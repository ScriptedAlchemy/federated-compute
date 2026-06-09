// Simulated WAN link: an HTTP proxy that adds region latency to every
// request passing through it. The consumer's "cross-region" entry points at
// this proxy; co-located services talk to the target directly.
import http from 'node:http';
import { PORTS, WAN_PORTS } from './machines.mjs';

export function startLatencyProxy({ port, targetPort, latencyMs = 75 }) {
  let latency = latencyMs;

  const server = http.createServer((req, res) => {
    if (req.url === '/__latency') {
      if (req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          let body;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid JSON body' }));
            return;
          }
          latency = Math.max(0, Math.min(Number(body.ms) || 0, 1000));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ms: latency }));
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ms: latency }));
      return;
    }

    const timer = setTimeout(() => {
      // Client gave up during the simulated latency window: skip the upstream.
      if (req.destroyed || res.destroyed || req.socket?.destroyed) return;
      const upstream = http.request(
        { host: '127.0.0.1', port: targetPort, path: req.url, method: req.method, headers: req.headers },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (res.headersSent || res.destroyed) return;
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'region link down' }));
      });
      req.pipe(upstream);
    }, latency);
    // Aborted/closed before forwarding: drop the pending forward entirely.
    res.on('close', () => {
      if (!res.writableEnded) clearTimeout(timer);
    });
    req.on('error', () => clearTimeout(timer));
  });

  return new Promise((resolve, reject) => {
    // Without this, a failed listen (e.g. EADDRINUSE) throws as an uncaught
    // 'error' event and crashes the demo with machines left orphaned.
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      console.log(`[wan] simulated region link on :${port} -> :${targetPort} (+${latency}ms/request)`);
      resolve({
        port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/**
 * Start one latency proxy per WAN_PORTS entry — every simulated region link
 * into the data region. Returns the proxy handles plus the REGION_LINKS
 * string the host consumes.
 */
export async function startWanLinks({ latencyMs = 75 } = {}) {
  const links = await Promise.all(
    Object.entries(WAN_PORTS).map(([name, port]) =>
      startLatencyProxy({ port, targetPort: PORTS[name], latencyMs }),
    ),
  );
  return {
    links,
    regionLinks: links.map(({ port }) => `http://127.0.0.1:${port}`).join(','),
    close: () => Promise.all(links.map((link) => link.close())),
  };
}
