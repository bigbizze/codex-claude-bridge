import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimitWait, sleepUntil, openaiResetAt } from './limits.mjs';

const policy = { anthropic: true, openai: false, maxWaitMs: 6 * 3600000, marginMs: 30000, maxCycles: 3 };
const quiet = () => {};

test('the wait follows the wall clock, stops on abort, and pauses the idle timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const controller = new AbortController();
  const idle = [];
  const wait = createLimitWait({ policy, signal: controller.signal, log: quiet, pauseIdle: () => idle.push('pause'), resumeIdle: () => idle.push('resume') });
  let done = false;
  const result = wait({ provider: 'anthropic', label: 'claude', resetAt: async () => 3600000 }).then(value => { done = value; });
  await new Promise(setImmediate);
  assert.deepEqual(idle, ['pause']);
  // A computer that sleeps moves the wall clock without firing timers.
  t.mock.timers.setTime(3600000 + 30000);
  t.mock.timers.tick(60000);
  await result;
  assert.equal(done, true);
  assert.deepEqual(idle, ['pause', 'resume']);

  const aborted = wait({ provider: 'anthropic', label: 'claude', resetAt: async () => Date.now() + 3600000 });
  await new Promise(setImmediate);
  controller.abort(new Error('Client disconnected.'));
  await assert.rejects(aborted, /Client disconnected/);
  assert.deepEqual(idle, ['pause', 'resume', 'pause', 'resume']);
});

test('no wait without opt-in, a known reset, a reset within the maximum, or remaining cycles', async () => {
  const signal = new AbortController().signal;
  const wait = createLimitWait({ policy: { ...policy, maxCycles: 1 }, signal, log: quiet, stepMs: 1 });
  assert.equal(await wait({ provider: 'openai', label: 'gpt', resetAt: async () => Date.now() }), false);
  assert.equal(await wait({ provider: 'anthropic', label: 'claude', resetAt: async () => undefined }), false);
  assert.equal(await wait({ provider: 'anthropic', label: 'claude', resetAt: async () => Date.now() + 7 * 3600000 }), false);
  assert.equal(await wait({ provider: 'anthropic', label: 'claude', resetAt: async () => Date.now() - 60000 }), true);
  assert.equal(await wait({ provider: 'anthropic', label: 'claude', resetAt: async () => Date.now() - 60000 }), false);
  let looked = false;
  assert.equal(await createLimitWait({ policy: {}, signal, log: quiet })({ provider: 'anthropic', resetAt: async () => { looked = true; return Date.now(); } }), false);
  assert.equal(looked, false, 'a disabled wait must not request usage');
});

test('OpenAI reset time comes from the error body, then usage, and is unknown without either', async () => {
  const headers = new Headers({ 'retry-after': '30' });
  const now = () => 1000000;
  const body = JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: 5000 } });
  assert.equal(await openaiResetAt({ body, headers, now }), 5000000);
  const inSeconds = JSON.stringify({ error: { type: 'usage_limit_reached', resets_in_seconds: 60 } });
  assert.equal(await openaiResetAt({ body: inSeconds, headers, now }), 1060000);
  const usage = { openai: async () => ({ windows: [{ usedPercent: 100, resetsAt: 9000000 }] }) };
  assert.equal(await openaiResetAt({ usage, body: '{"error":{"message":"busy"}}', headers, requestHeaders: {}, now }), 9000000);
  assert.equal(await openaiResetAt({ usage: { openai: async () => undefined }, body: 'not json', headers, requestHeaders: {}, now }), undefined);
});

test('sleepUntil returns at once for a past time', async () => {
  await sleepUntil(Date.now() - 1, undefined);
});
