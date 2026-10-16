import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createBridge, createCodec, translate } from './bridge.mjs';
import { openaiRequest } from './routing.mjs';

const model = { provider: 'anthropic', id: 'claude-test', api: 'anthropic-messages' };
const modelId = 'anthropic/claude-test';
const codec = createCodec(randomBytes(32));
const thinking = { type: 'thinking', thinking: 'Original thought', thinkingSignature: 'original-signature' };
const claudeReasoning = { type: 'reasoning', id: 'rs_claude', encrypted_content: codec.seal(thinking, modelId), summary: [{ type: 'summary_text', text: 'Claude summary' }] };
const openaiReasoning = { type: 'reasoning', id: 'rs_openai', encrypted_content: 'openai-opaque', summary: [{ type: 'summary_text', text: 'OpenAI summary' }] };

test('outgoing projections preserve original state across both providers and new messages', () => {
  const input = [
    { type: 'message', role: 'user', content: 'Remember this' }, claudeReasoning,
    { type: 'message', role: 'assistant', content: 'Claude answer' },
    { type: 'message', role: 'user', content: 'Switch to OpenAI' }, openaiReasoning,
    { type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
    { type: 'function_call_output', call_id: 'call_1', output: '/tmp' },
    { type: 'message', role: 'assistant', content: 'OpenAI answer' },
    { type: 'message', role: 'user', content: 'Switch back' },
  ];
  const original = structuredClone(input);
  const projected = openaiRequest({ model: 'gpt-6-astra', input });
  assert.doesNotMatch(JSON.stringify(projected), /pi1\./);
  assert.match(JSON.stringify(projected), /Claude summary/);
  assert.deepEqual(projected.input.find(item => item.id === 'rs_openai'), openaiReasoning);
  assert.deepEqual(projected.input.filter(item => item.type.startsWith('function_call')), input.filter(item => item.type.startsWith('function_call')));
  const restored = translate({ input }, model, codec);
  assert.ok(restored.context.messages.some(message => message.content.some(block => block.thinkingSignature === thinking.thinkingSignature)));
  assert.match(JSON.stringify(restored), /OpenAI summary/);
  assert.match(JSON.stringify(restored), /OpenAI answer/);
  assert.doesNotMatch(JSON.stringify(restored), /openai-opaque/);
  const changedModel = translate({ input }, { ...model, id: 'different-claude' }, codec);
  const historical = changedModel.context.messages.find(message => message.content.some(block => block.type === 'thinking'));
  assert.equal(historical.model, model.id);
  assert.equal(historical.provider, model.provider);
  assert.deepEqual(input, original);
});

test('opaque foreign reasoning without a summary stays in history but is omitted from the other provider', () => {
  const item = { ...claudeReasoning, summary: [] };
  assert.deepEqual(openaiRequest({ input: [item] }).input, []);
  assert.deepEqual(item.encrypted_content, claudeReasoning.encrypted_content);
  assert.equal(translate({ input: [{ ...openaiReasoning, summary: [] }] }, model, codec).context.messages.length, 0);
  assert.throws(() => translate({ input: [{ type: 'reasoning', encrypted_content: 'pi1.invalid' }] }, model, codec), /Cannot restore/);
});

test('legacy Claude custom tool IDs use the OpenAI ctc prefix only in outgoing requests', () => {
  const input = [
    { type: 'custom_tool_call', id: 'fc_98a04a4d-9630-4e7e-9ddb-d790490adf2c', call_id: 'toolu_1', name: 'apply_patch', input: 'patch' },
    { type: 'custom_tool_call_output', call_id: 'toolu_1', output: 'done' },
    { type: 'custom_tool_call', id: 'ctc_native', call_id: 'call_2', name: 'apply_patch', input: 'another patch' },
    { type: 'function_call', id: 'fc_native', call_id: 'call_3', name: 'shell', arguments: '{}' },
  ];
  const original = structuredClone(input);
  const projected = openaiRequest({ input }).input;
  assert.equal(projected[0].id, 'ctc_98a04a4d-9630-4e7e-9ddb-d790490adf2c');
  assert.equal(projected[0].call_id, projected[1].call_id);
  assert.deepEqual(projected.slice(1), input.slice(1));
  assert.deepEqual(input, original);
});

test('OpenAI routing uses native authentication, filters history, streams responses and never forwards the bridge token', async t => {
  const calls = [];
  const stream = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_native"}}\n\n';
  const bridge = createBridge({ token: 'local-secret', codec, registry: { getAvailable: () => [model], streamSimple() { throw new Error('OpenAI was routed to Pi'); } },
    openai: { catalog: { models: [{ slug: 'gpt-6-astra' }] }, fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'x-codex-primary-used-percent': '42' } });
    } },
  });
  bridge.server.listen(0, '127.0.0.1'); await once(bridge.server, 'listening');
  t.after(() => bridge.close());
  const url = `http://127.0.0.1:${bridge.server.address().port}`;
  const headers = { 'x-codex-bridge-token': 'local-secret', authorization: 'Bearer native-token', 'chatgpt-account-id': 'test-account', 'content-type': 'application/json' };
  const response = await fetch(`${url}/v1/responses`, { method: 'POST', headers, body: JSON.stringify({ model: 'openai/gpt-6-astra', stream: true, input: [claudeReasoning, openaiReasoning] }) });
  assert.equal(await response.text(), stream);
  assert.equal(response.headers.get('x-codex-primary-used-percent'), '42');
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(calls[0].options.headers.get('authorization'), 'Bearer native-token');
  assert.equal(calls[0].options.headers.get('chatgpt-account-id'), 'test-account');
  assert.equal(calls[0].options.headers.has('x-codex-bridge-token'), false);
  assert.doesNotMatch(calls[0].options.body, /pi1\./);
  assert.match(calls[0].options.body, /openai-opaque/);
  assert.equal(JSON.parse(calls[0].options.body).model, 'gpt-6-astra');
  const models = await (await fetch(`${url}/v1/models`, { headers })).json();
  assert.deepEqual(new Set(models.models.map(entry => entry.slug)), new Set([modelId, 'openai/gpt-6-astra']));
  for (const auth of [{ authorization: 'Bearer native-token' }, { authorization: 'Bearer local-secret' }, { ...headers, 'x-codex-bridge-token': 'wrong' }]) {
    const rejected = await fetch(`${url}/v1/responses`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'gpt-6-astra', input: 'Hi' }) });
    assert.equal(rejected.status, 401);
  }
  assert.equal(calls.length, 1);
});

test('OpenAI upstream errors preserve authentication and retry status', async t => {
  const bridge = createBridge({ token: 'local-secret', codec, registry: { getAvailable: () => [] },
    openai: { catalog: { models: [{ slug: 'gpt-6-astra' }] }, fetchImpl: async (url) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      return new Response('{"error":{"message":"Retry later"}}', { status: 429, headers: { 'retry-after': '30', 'content-type': 'application/json' } });
    } },
  });
  bridge.server.listen(0, '127.0.0.1'); await once(bridge.server, 'listening');
  t.after(() => bridge.close());
  const response = await fetch(`http://127.0.0.1:${bridge.server.address().port}/v1/responses`, {
    method: 'POST', headers: { 'x-codex-bridge-token': 'local-secret', authorization: 'Bearer api-key' }, body: JSON.stringify({ model: 'gpt-6-astra', input: 'Hi' }),
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '30');
  assert.equal((await response.json()).error.message, 'Retry later');
});
