import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

/** Request-level failure with a definite HTTP status (vs a generic 500). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += (chunk as Buffer).length;
    if (bytes > 64 * 1024) throw new HttpError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    // Deliberately constant message: JSON.parse errors echo request content.
    throw new HttpError(400, 'invalid JSON body');
  }
}

export function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

const PUBLIC_DIR = path.resolve(import.meta.dirname, '../public');

// Pretty page routes -> files in PUBLIC_DIR; other assets (*.css, *.js) are
// served by filename. The asset pattern admits no '/' so paths can't escape
// the dir.
const PAGES: Record<string, string> = {
  '/': 'index.html',
  '/gravity': 'gravity.html',
  '/fluid': 'fluid.html',
  '/android': 'android.html',
  '/screen': 'screen.html',
};
const ASSET_RE = /^\/[A-Za-z0-9_-]+\.(css|js)$/;
const ASSET_TYPES: Record<string, string> = { '.css': 'text/css', '.js': 'text/javascript' };

/** Serve a page or asset from PUBLIC_DIR; false when the path is not static. */
export async function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  const page = PAGES[url.pathname];
  const file = page ?? (ASSET_RE.test(url.pathname) ? url.pathname.slice(1) : undefined);
  if (!file) return false;
  try {
    const body = await readFile(path.join(PUBLIC_DIR, file));
    res.writeHead(200, { 'content-type': page ? 'text/html' : ASSET_TYPES[path.extname(file)] });
    res.end(body);
  } catch {
    json(res, 404, { error: 'not found' });
  }
  return true;
}
