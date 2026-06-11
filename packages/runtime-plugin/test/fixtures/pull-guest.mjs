// Self-contained protocol v3 guest used as the PULLED IMAGE in pull tests.
// It runs as a bare child process booted by the process driver, so it must
// not import anything from this package — plain node:http only.
import http from 'node:http';

let counter = 0;
const name = 'pull_fixture_machine';

const manifest = {
  name,
  protocol: 3,
  version: '1.0.0',
  metaData: { runtime: `node ${process.version}`, features: ['state'] },
  exposes: {
    './counter': {
      increment: { params: [], returns: 'number' },
      current: { params: [], returns: 'number' },
    },
    './admin': {
      die: { params: [], returns: 'string' },
    },
  },
};

const fns = {
  './counter': {
    increment: () => ++counter,
    current: () => counter,
  },
  './admin': {
    // Answers first, then dies: the *next* call hits a dead machine.
    die: () => {
      setTimeout(() => process.exit(1), 50);
      return 'dying';
    },
  },
};

const server = http.createServer((req, res) => {
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/mf/health') return json(200, { ok: true, name });
  if (req.method === 'GET' && req.url === '/mf-manifest.json') return json(200, manifest);
  if (req.method === 'GET' && req.url === '/mf/state') {
    return json(200, { ok: true, state: { counter } });
  }
  if (req.method === 'POST' && (req.url === '/mf/state' || req.url === '/mf/call')) {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return json(400, {
          ok: false,
          error: { message: 'malformed request body', type: 'ParseError' },
        });
      }
      if (req.url === '/mf/state') {
        counter = parsed?.state?.counter ?? 0;
        return json(200, { ok: true });
      }
      const fn = fns[parsed.module]?.[parsed.fn];
      if (!fn) {
        return json(200, {
          ok: false,
          error: { message: `unknown ${parsed.module}#${parsed.fn}`, type: 'Error' },
        });
      }
      return json(200, { ok: true, result: fn(...(parsed.args ?? [])) });
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(Number(process.env.PORT ?? 0), '127.0.0.1');
