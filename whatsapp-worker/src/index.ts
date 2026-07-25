import 'dotenv/config';
import http, { type IncomingMessage, type ServerResponse } from 'http';
import { config } from './config.js';
import { startConnection, stopConnection, sendViaBaileys, type SendRequest } from './baileys-client.js';
import { listConnectedAccountIds } from './connections.js';

/**
 * Minimal HTTP server — no framework dependency, on purpose: this
 * worker exposes exactly three authenticated routes plus a health
 * check, so a router library would be more surface area than it
 * saves. See README.md for the full route list and the main app's
 * `src/lib/whatsapp/baileys-provider.ts` / `.../api/whatsapp/baileys/
 * connect/route.ts` for the two callers.
 */

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    return null;
  }
}

function isAuthorized(req: IncomingMessage): boolean {
  return req.headers.authorization === `Bearer ${config.workerApiSecret}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const segments = url.pathname.split('/').filter(Boolean);

  if (req.method === 'GET' && segments[0] === 'health') {
    send(res, 200, { ok: true });
    return;
  }

  if (!isAuthorized(req)) {
    send(res, 401, { error: 'Unauthorized' });
    return;
  }

  try {
    if (req.method === 'POST' && segments[0] === 'connect' && segments[1]) {
      await startConnection(segments[1]);
      send(res, 200, { success: true });
      return;
    }

    if (req.method === 'POST' && segments[0] === 'disconnect' && segments[1]) {
      await stopConnection(segments[1]);
      send(res, 200, { success: true });
      return;
    }

    if (req.method === 'POST' && segments[0] === 'send' && segments[1]) {
      const body = await readJsonBody<SendRequest>(req);
      if (!body || !body.type || !body.to) {
        send(res, 400, { error: 'Invalid send payload' });
        return;
      }
      const result = await sendViaBaileys(segments[1], body);
      send(res, 200, result);
      return;
    }

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('[http] request failed:', err);
    send(res, 500, { error: err instanceof Error ? err.message : 'Internal error' });
  }
});

async function main() {
  // Reconnect every account that was connected before this process
  // started — a worker restart/redeploy shouldn't force a fresh QR
  // scan for accounts that were already paired.
  const accountIds = await listConnectedAccountIds();
  for (const accountId of accountIds) {
    startConnection(accountId).catch((err) =>
      console.error(`[startup] failed to reconnect ${accountId}:`, err),
    );
  }

  server.listen(config.port, () => {
    console.log(`[whatsapp-worker] listening on :${config.port}`);
  });
}

main().catch((err) => {
  console.error('[whatsapp-worker] fatal startup error:', err);
  process.exit(1);
});
