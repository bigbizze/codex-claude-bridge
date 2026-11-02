import https from 'node:https';
import tls from 'node:tls';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { codexRateLimit } from './usage.mjs';

// Codex reads usage limits only from its ChatGPT backend, and it requires HTTPS
// for that origin. This proxy is that backend: it forwards every request to the
// fixed ChatGPT origin and adds Claude to the `/wham/usage` response.
const ORIGIN = 'chatgpt.com';
const hopByHop = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'content-length', 'accept-encoding', 'expect']);

export function mergeUsage(body, claude, now = Date.now()) {
  if (!claude || !body || typeof body !== 'object' || !body.rate_limit) return body;
  const others = (Array.isArray(body.additional_rate_limits) ? body.additional_rate_limits : []).filter(entry => entry?.metered_feature !== 'claude');
  return { ...body, additional_rate_limits: [...others, codexRateLimit(claude, now)] };
}

export function createBackend({ key, cert, usageReader, fetchImpl = fetch, origin = `https://${ORIGIN}`, log = () => {} }) {
  const server = https.createServer({ key, cert }, async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const url = new URL(req.url, origin);
      if (url.origin !== origin) throw new Error('Absolute request URLs are not accepted.');
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (!hopByHop.has(name) && !name.startsWith('sec-websocket-')) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const hasBody = !['GET', 'HEAD'].includes(req.method);
      const usage = req.method === 'GET' && url.pathname.replace(/\/+$/, '').endsWith('/wham/usage');
      const [upstream, claude] = await Promise.all([
        fetchImpl(url, { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: hasBody ? 'half' : undefined,
          redirect: 'manual', signal: controller.signal }),
        usage ? usageReader?.claude().catch(() => undefined) : undefined,
      ]);
      const responseHeaders = {};
      // fetch decodes the body, so the upstream encoding and length are no longer valid.
      for (const [name, value] of upstream.headers) if (!hopByHop.has(name) && name !== 'content-encoding' && name !== 'set-cookie') responseHeaders[name] = value;
      const cookies = upstream.headers.getSetCookie();
      if (cookies.length) responseHeaders['set-cookie'] = cookies;
      if (usage && upstream.status === 200 && /json/.test(upstream.headers.get('content-type') ?? '')) {
        const text = await upstream.text();
        let body = text;
        try { body = JSON.stringify(mergeUsage(JSON.parse(text), claude)); } catch {}
        res.writeHead(upstream.status, responseHeaders);
        res.end(body);
        return;
      }
      res.writeHead(upstream.status, responseHeaders);
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
      else res.end();
    } catch (error) {
      if (controller.signal.aborted) return;
      log(`[pi-codex] backend request failed: ${error.message}`);
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'ChatGPT backend proxy failed.' } })); }
      else res.destroy();
    }
  });
  // WebSocket upgrades go through unchanged as a TLS tunnel to the same origin.
  server.on('upgrade', (req, socket, head) => {
    const upstream = tls.connect({ host: ORIGIN, port: 443, servername: ORIGIN, ALPNProtocols: ['http/1.1'] }, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`, `host: ${ORIGIN}`];
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        if (req.rawHeaders[index].toLowerCase() !== 'host') lines.push(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}`);
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    const close = () => { upstream.destroy(); socket.destroy(); };
    upstream.on('error', close); socket.on('error', close); upstream.on('close', close); socket.on('close', close);
  });
  return server;
}
