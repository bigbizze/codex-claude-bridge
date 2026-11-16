import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnostics } from './warnings.mjs';
import { createLimitWait } from './limits.mjs';

test('limit waits announce the reset and retry without debug logging', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const output = [];
  const diagnostics = createDiagnostics({ write: chunk => output.push(chunk) });
  const log = line => diagnostics(Buffer.from(line + '\n'));
  const wait = createLimitWait({ policy: { anthropic: true, maxWaitMs: 7200000, marginMs: 0, maxCycles: 1 },
    signal: new AbortController().signal, log });
  const result = wait({ provider: 'anthropic', label: 'anthropic/claude-test', resetAt: async () => 3600000 });
  await new Promise(setImmediate);
  assert.equal(output.length, 1);
  assert.match(output[0], /anthropic\/claude-test usage limit reached; waiting until .+ \(60 min\)/);
  context.mock.timers.tick(3600000);
  assert.equal(await result, true);
  assert.match(output[1], /usage limit wait ended; sending the request again/);
});

test('diagnostics handles split UTF-8 lines and hides unrelated provider logs', () => {
  const output = [];
  const diagnostics = createDiagnostics({ write: chunk => output.push(chunk) });
  const notice = '[pi-codex] anthropic/claude-test usage limit reached; waiting until 4:00\u202fPM (25 min)\n';
  const data = Buffer.from('[pi-codex] done reason=stop\n' + notice + '[pi-codex] request failed: details\n');
  for (const byte of data) diagnostics(Buffer.from([byte]));
  assert.deepEqual(output, [notice]);
});

test('debug mode forwards raw chunks exactly once', () => {
  const output = [];
  const diagnostics = createDiagnostics({ debug: true, write: chunk => output.push(chunk) });
  const chunk = Buffer.from('[pi-codex] anthropic/claude-test usage limit reached; waiting until later\nother diagnostics');
  diagnostics(chunk);
  assert.deepEqual(output, [chunk]);
});
