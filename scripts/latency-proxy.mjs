// Simulated WAN link: an HTTP proxy that adds region latency to every
// request passing through it. The consumer's "cross-region" entry points at
// this proxy; co-located services talk to the target directly.
import http from 'node:http';

export function startLatencyProxy({ port, targetPort, latencyMs = 75 }) {
  let latency = latencyMs;

  const server = http.createServer((req, res) => {
    if (req.url === '/__latency') {
      if (req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
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

    setTimeout(() => {
      const upstream = http.request(
        { host: '127.0.0.1', port: targetPort, path: req.url, method: req.method, headers: req.headers },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      upstream.on('error', () => {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'region link down' }));
      });
      req.pipe(upstream);
    }, latency);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`[wan] simulated region link on :${port} -> :${targetPort} (+${latency}ms/request)`);
      resolve({
        port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
