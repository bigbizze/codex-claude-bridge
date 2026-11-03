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

// Codex cannot send a header to its backend, so the per-launch secret is the
// first path segment of chatgpt_base_url. Other local users cannot use the proxy.
const unprefixed = (path, secret) => path.startsWith(`/${secret}/`) ? path.slice(secret.length + 1) : undefined;

// Certificate errors stay until the user acts, for example after TLS inspection
// starts. Other connection errors are usually temporary network failures.
const certificateError = error => /CERT|SIGNATURE|ISSUER/.test(error?.cause?.code ?? error?.code ?? '');
const proxyHint = 'Set NODE_EXTRA_CA_CERTS for TLS inspection, or set CODEX_BRIDGE_STATUS=0.';

export function createBackend({ key, cert, secret, usageReader, fetchImpl = fetch, origin = `https://${ORIGIN}`, log = () => {}, warn = log }) {
  const server = https.createServer({ key, cert }, async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const path = unprefixed(req.url, secret);
    if (!path) { res.writeHead(404).end(); return; }
    try {
      const url = new URL(path, origin);
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
        let parsed;
        try { parsed = JSON.parse(text); } catch {}
        if (!parsed || typeof parsed !== 'object' || !('rate_limit' in parsed)) warn('ChatGPT usage format changed. Claude limits are not shown in /status until the bridge is updated.');
        else body = JSON.stringify(mergeUsage(parsed, claude));
        res.writeHead(upstream.status, responseHeaders);
        res.end(body);
        return;
      }
      res.writeHead(upstream.status, responseHeaders);
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
      else res.end();
    } catch (error) {
      if (controller.signal.aborted) return;
      if (certificateError(error)) warn(`ChatGPT backend proxy cannot verify chatgpt.com (${error.cause?.code ?? error.code}). ${proxyHint}`);
      else log(`backend request failed: ${error.message}`);
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'ChatGPT backend proxy failed.' } })); }
      else res.destroy();
    }
  });
  // WebSocket upgrades go through unchanged as a TLS tunnel to the same origin.
  server.on('upgrade', (req, socket, head) => {
    const path = unprefixed(req.url, secret);
    if (!path) { socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n'); return; }
    const upstream = tls.connect({ host: ORIGIN, port: 443, servername: ORIGIN, ALPNProtocols: ['http/1.1'] }, () => {
      const lines = [`${req.method} ${path} HTTP/1.1`, `host: ${ORIGIN}`];
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        if (req.rawHeaders[index].toLowerCase() !== 'host') lines.push(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}`);
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    const close = () => { upstream.destroy(); socket.destroy(); };
    upstream.on('error', error => {
      if (certificateError(error)) warn(`ChatGPT backend proxy cannot verify chatgpt.com (${error.code}). ${proxyHint}`);
      else log(`backend tunnel failed: ${error.message}`);
      close();
    });
    socket.on('error', close); upstream.on('close', close); socket.on('close', close);
  });
  return server;
}
