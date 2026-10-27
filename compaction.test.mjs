import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { previousModelCompaction, selectedModelForTurn, createSelectedModelReader } from './compaction.mjs';
import { createBridge, createCodec } from './bridge.mjs';

const threadId = '00000000-0000-0000-0000-000000000001';
const turnId = '00000000-0000-0000-0000-000000000002';
const identity = { threadId, turnId };
const model = { provider: 'anthropic', id: 'claude-test', api: 'anthropic-messages' };
const modelId = 'anthropic/claude-test';
const selected = { model: 'openai/gpt-6-astra', reasoningEffort: 'medium' };
const metadata = { thread_id: threadId, turn_id: turnId, request_kind: 'compaction',
  compaction: { trigger: 'auto', phase: 'pre_turn', reason: 'model_downshift' } };
const settings = (name = selected.model) => ({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: threadId,
  thread_settings: { model: name, model_provider_id: 'pi_claude', reasoning_effort: 'medium' } } });
const started = { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } };
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 };
const rateLimit = { type: 'error', error: { errorMessage: 'Server requested 1634s retry delay (max: 60s). 429 {"type":"error","error":{"type":"rate_limit_error"}}' } };

test('only explicit previous-model compaction metadata permits fallback', () => {
  const request = { client_metadata: { 'x-codex-turn-metadata': JSON.stringify(metadata) } };
  assert.deepEqual(previousModelCompaction(request, {}), identity);
  assert.deepEqual(previousModelCompaction({}, { 'x-codex-turn-metadata': JSON.stringify(metadata) }), identity);
  for (const value of [null, {}, { ...metadata, request_kind: 'turn' }, { ...metadata, thread_id: '../other' },
    ...['trigger', 'phase', 'reason'].map(key => ({ ...metadata, compaction: { ...metadata.compaction, [key]: 'other' } }))]) {
    assert.equal(previousModelCompaction({ client_metadata: { 'x-codex-turn-metadata': JSON.stringify(value) } }, {}), undefined);
  }
  assert.equal(previousModelCompaction({ input: JSON.stringify(metadata) }, {}), undefined);
});

test('selection is bound to the exact thread and active turn, not a later picker change', () => {
  assert.deepEqual(selectedModelForTurn([settings(), started, settings(modelId)], identity), selected);
  assert.equal(selectedModelForTurn([settings(), started], { ...identity, turnId: threadId }), undefined);
  assert.equal(selectedModelForTurn([settings(), started], { ...identity, threadId: turnId }), undefined);
  assert.equal(selectedModelForTurn([started, settings()], identity), undefined);
  assert.equal(selectedModelForTurn([settings(), started, { ...started, payload: { ...started.payload, turn_id: threadId } }], identity), undefined);
  for (const type of ['task_complete', 'turn_aborted']) {
    assert.equal(selectedModelForTurn([settings(), started, { type: 'event_msg', payload: { type, turn_id: turnId } }], identity), undefined);
  }
});

test('reads persisted selection without modifying the rollout and declines incomplete records', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'compaction-reader-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const folder = join(dir, 'sessions', '2026', '10', '27');
  await mkdir(folder, { recursive: true });
  const file = join(folder, `rollout-test-${threadId}.jsonl`);
  const contents = [settings(), started].map(row => JSON.stringify(row) + '\n').join('');
  await writeFile(file, contents);
  const reader = createSelectedModelReader(dir);
  assert.deepEqual(await reader(identity), selected);
  assert.equal(await readFile(file, 'utf8'), contents);
  await writeFile(file, contents + '{"type":');
  assert.equal(await reader(identity), undefined);
  assert.equal(await reader({ ...identity, threadId: '../auth' }), undefined);
});

async function fixture(t, { streamSimple, fetchImpl, selectedModel = async () => selected } = {}) {
  const claudeCalls = [];
  const openaiCalls = [];
  const bridge = createBridge({ token: 'test-bridge', codec: createCodec(randomBytes(32)), selectedModel,
    registry: { getAvailable: () => [model], streamSimple(...args) { claudeCalls.push(args); return streamSimple(...args); } },
    openai: { catalog: { models: [{ slug: 'gpt-6-astra' }] }, fetchImpl: async (...args) => {
      openaiCalls.push(args);
      return fetchImpl ? fetchImpl(...args) : new Response('data: {"type":"response.completed","response":{"id":"resp_fallback"}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    } },
  });
  bridge.server.listen(0, '127.0.0.1'); await once(bridge.server, 'listening');
  t.after(() => bridge.close());
  const request = (body = {}, extraHeaders = {}, signal) => fetch(`http://127.0.0.1:${bridge.server.address().port}/v1/responses`, {
    method: 'POST', signal, headers: { 'x-codex-bridge-token': 'test-bridge', authorization: 'Bearer test-openai', ...extraHeaders },
    body: JSON.stringify({ model: modelId, stream: true, input: [{ role: 'user', content: 'Summarize the existing history.' }],
      client_metadata: { 'x-codex-turn-metadata': JSON.stringify(metadata) }, ...body }),
  });
  return { request, claudeCalls, openaiCalls };
}

test('Anthropic compaction 429 retries selected OpenAI model with one clean stream and original input', async t => {
  const f = await fixture(t, { async *streamSimple() { yield { type: 'start', partial: { content: [] } }; yield rateLimit; } });
  const response = await f.request();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'data: {"type":"response.completed","response":{"id":"resp_fallback"}}\n\n');
  assert.equal(f.claudeCalls.length, 1);
  assert.equal(f.openaiCalls.length, 1);
  const outgoing = JSON.parse(f.openaiCalls[0][1].body);
  assert.equal(outgoing.model, 'gpt-6-astra');
  assert.equal(outgoing.reasoning.effort, 'medium');
  assert.match(JSON.stringify(outgoing.input), /Summarize the existing history/);
  assert.equal(f.openaiCalls[0][1].headers.has('x-codex-bridge-token'), false);
});

for (const scenario of ['normal turn', 'manual compact', 'unknown selection', 'same model', 'unsupported model', 'missing native auth', 'non-429', 'partial stream']) {
  test(`does not fall back for ${scenario}`, async t => {
    const f = await fixture(t, { selectedModel: async () => scenario === 'unknown selection' ? undefined
      : scenario === 'same model' ? { model: modelId } : scenario === 'unsupported model' ? { model: 'openai/unknown' } : selected,
    async *streamSimple() {
      if (scenario === 'partial stream') yield { type: 'text_delta', contentIndex: 0, delta: 'partial', partial: { content: [{ type: 'text', text: 'partial' }] } };
      yield scenario === 'non-429' ? { type: 'error', error: { errorMessage: '401 authentication failed' } } : rateLimit;
    } });
    const body = scenario === 'normal turn' ? { client_metadata: {} } : scenario === 'manual compact'
      ? { client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ ...metadata, compaction: { ...metadata.compaction, trigger: 'manual' } }) } } : {};
    const response = await f.request(body, scenario === 'missing native auth' ? { authorization: 'Bearer test-bridge' } : {});
    assert.match(await response.text(), /response.failed/);
    assert.equal(f.openaiCalls.length, 0);
  });
}

test('a failed destination attempt is surfaced without a fallback loop', async t => {
  const f = await fixture(t, { async *streamSimple() { yield rateLimit; },
    fetchImpl: async () => new Response('{"error":{"message":"destination quota exhausted"}}', { status: 429, headers: { 'retry-after': '60' } }) });
  const response = await f.request();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.match(await response.text(), /destination quota exhausted/);
  assert.equal(f.claudeCalls.length, 1);
  assert.equal(f.openaiCalls.length, 1);
});

test('destination context-size errors are preserved', async t => {
  const body = '{"error":{"code":"context_length_exceeded","message":"Context window exceeded"}}';
  const f = await fixture(t, { async *streamSimple() { yield rateLimit; },
    fetchImpl: async () => new Response(body, { status: 400, headers: { 'content-type': 'application/json' } }) });
  const response = await f.request();
  assert.equal(response.status, 400);
  assert.equal(await response.text(), body);
  assert.equal(f.openaiCalls.length, 1);
});

test('successful original compaction does not look up or call a fallback', async t => {
  const f = await fixture(t, { selectedModel: () => { throw new Error('Unexpected selection lookup'); },
    async *streamSimple() { yield { type: 'done', reason: 'stop', message: { content: [{ type: 'text', text: 'Original summary' }], usage } }; } });
  const response = await f.request();
  const text = await response.text();
  assert.match(text, /Original summary/);
  assert.match(text, /response.completed/);
  assert.equal(f.openaiCalls.length, 0);
});

test('non-streaming compaction can also retry without modifying the response format', async t => {
  const body = '{"id":"resp_fallback","status":"completed","output":[]}';
  const f = await fixture(t, { async *streamSimple() { yield rateLimit; },
    fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).stream, false);
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    } });
  const response = await f.request({ stream: false });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), body);
});

test('client cancellation while resolving the selection prevents a destination request', async t => {
  let lookupStarted;
  const started = new Promise(resolve => { lookupStarted = resolve; });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let disconnected;
  const closed = new Promise(resolve => { disconnected = resolve; });
  const f = await fixture(t, { selectedModel: async () => { lookupStarted(); await pending; return selected; },
    async *streamSimple(_model, _context, { signal }) { signal.addEventListener('abort', disconnected, { once: true }); yield rateLimit; } });
  // fixture requests use fetch; abandoning a body before headers requires an AbortSignal.
  const controller = new AbortController();
  const request = f.request({}, {}, controller.signal).catch(error => error);
  await started;
  controller.abort();
  await closed;
  release();
  assert.equal((await request).name, 'AbortError');
  assert.equal(f.openaiCalls.length, 0);
});

test('OpenAI compaction HTTP 429 can fall back to the selected Anthropic model', async t => {
  const f = await fixture(t, { selectedModel: async () => ({ model: modelId }),
    fetchImpl: async () => new Response('rate limited', { status: 429 }),
    async *streamSimple() { yield { type: 'done', reason: 'stop', message: { content: [{ type: 'text', text: 'Recovered summary' }], usage } }; } });
  const response = await f.request({ model: 'openai/gpt-6-astra' });
  assert.match(await response.text(), /Recovered summary/);
  assert.equal(f.claudeCalls.length, 1);
  assert.equal(f.openaiCalls.length, 1);
});
