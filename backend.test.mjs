import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { createBackend, mergeUsage } from './backend.mjs';
import { createLocalCertificates } from './certs.mjs';

const chatgpt = { plan_type: 'pro', rate_limit: { allowed: true, primary_window: { used_percent: 19 } },
  additional_rate_limits: [{ limit_name: 'Other', metered_feature: 'other', rate_limit: {} }] };
const claude = { provider: 'anthropic', windows: [{ id: 'five_hour', usedPercent: 100, windowSeconds: 18000, resetsAt: 2000000 }] };

test('Claude is added to the ChatGPT usage response without changing ChatGPT data', () => {
  const merged = mergeUsage(chatgpt, claude, 1000000);
  assert.deepEqual(merged.rate_limit, chatgpt.rate_limit);
  assert.deepEqual(merged.additional_rate_limits.map(entry => entry.metered_feature), ['other', 'claude']);
  assert.equal(merged.additional_rate_limits[1].rate_limit.limit_reached, true);
  assert.equal(mergeUsage(chatgpt, undefined), chatgpt);
  assert.deepEqual(mergeUsage({ error: 'x' }, claude), { error: 'x' });
});

let openssl = true;
try { execFileSync('openssl', ['version']); } catch { openssl = false; }

test('the proxy needs the secret, forwards only to the fixed origin, and keeps ChatGPT data when Claude usage fails', { skip: !openssl && 'openssl is not installed' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'backend-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = await createLocalCertificates(dir);
  const calls = [];
  const backend = createBackend({ key: readFileSync(files.key), cert: readFileSync(files.cert), secret: 'secret',
    usageReader: { claude: async () => { throw new Error('offline'); } },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), headers: options.headers });
      return url.pathname.endsWith('/wham/usage') ? Response.json(chatgpt) : new Response('plain', { headers: { 'content-type': 'text/plain' } });
    } });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  t.after(() => backend.close());
  const get = path => new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port: backend.address().port, path, ca: readFileSync(files.ca), servername: 'localhost',
      headers: { host: 'evil.example', authorization: 'Bearer chatgpt' } }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  const usage = await get('/secret/backend-api/wham/usage');
  assert.deepEqual(JSON.parse(usage.body), chatgpt);
  assert.equal((await get('/secret/backend-api/plugins')).body, 'plain');
  assert.equal((await get('/backend-api/plugins')).status, 404);
  assert.equal((await get('/wrong/backend-api/plugins')).status, 404);
  assert.equal((await get('https://evil.example/secret/backend-api/x')).status, 404);
  assert.equal((await get('/secret//evil.example/x')).status, 502);
  assert.deepEqual(calls.map(call => call.url), ['https://chatgpt.com/backend-api/wham/usage', 'https://chatgpt.com/backend-api/plugins']);
  assert.equal(calls[0].headers.get('authorization'), 'Bearer chatgpt');
  assert.equal(calls[0].headers.has('host'), false);
});
