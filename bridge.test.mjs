import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createBridge, createCodec, catalog, translate } from './bridge.mjs';

const model = { id: 'claude-test', name: 'Test Claude', provider: 'anthropic', api: 'anthropic-messages', reasoning: true, input: ['text', 'image'], contextWindow: 1000000, maxTokens: 64000 };
const modelId = 'anthropic/claude-test';
const codec = createCodec(randomBytes(32));
const usage = { input: 12, output: 5, cacheRead: 20, cacheWrite: 3, totalTokens: 40 };
const assistant = content => ({ role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', usage, timestamp: Date.now() });
async function start(t, streamSimple, timeout) {
  const bridge = createBridge({ registry: { getAvailable: () => [model], streamSimple }, token: 'test-token', codec, requestTimeoutMs: timeout });
  bridge.server.listen(0, '127.0.0.1'); await once(bridge.server, 'listening');
  t.after(() => bridge.close());
  const url = `http://127.0.0.1:${bridge.server.address().port}`;
  const request = (body, options = {}) => fetch(`${url}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: JSON.stringify({ model: modelId, input: 'Hi', ...body }), ...options });
  return { url, request };
}
function events(text) { return text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))); }

test('catalog uses Pi limits, supported inputs and valid coding instructions', () => {
  const entry = catalog([model]).models[0];
  assert.equal(entry.context_window, 1000000);
  assert.equal(entry.default_reasoning_level, 'medium');
  assert.ok(entry.model_messages.instructions_template.includes('Codex CLI'));
  assert.ok(!entry.model_messages.instructions_template.includes('"command":["apply_patch"'));
});

test('preserves namespace calls, parallel calls, custom inputs, developer instructions and images', () => {
  const encrypted = codec.seal({ type: 'thinking', thinking: 'plan', thinkingSignature: 'signed' }, modelId);
  const request = { model: modelId, instructions: 'base', tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }, { type: 'custom', name: 'apply_patch' }] }], input: [
    { role: 'developer', content: 'extra' }, { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,YQ==' }] },
    { type: 'reasoning', encrypted_content: encrypted },
    { type: 'function_call', namespace: 'functions', name: 'exec_command', call_id: 'call_1', arguments: '{"cmd":"pwd"}' },
    { type: 'custom_tool_call', namespace: 'functions', name: 'apply_patch', call_id: 'call_2', input: '*** Begin Patch\n*** End Patch' },
    { type: 'function_call_output', call_id: 'call_1', output: '/tmp' },
    { type: 'custom_tool_call_output', call_id: 'call_2', output: 'done' },
  ] };
  const result = translate(request, model, codec);
  assert.equal(result.context.systemPrompt, 'base');
  assert.equal(result.context.messages[0].role, 'system');
  assert.equal(result.context.messages[1].content[0].type, 'image');
  assert.equal(result.context.messages[2].content.length, 3);
  assert.equal(result.context.messages[2].content[0].thinkingSignature, 'signed');
  assert.equal(result.context.messages[2].content[2].arguments.input, '*** Begin Patch\n*** End Patch');
  assert.equal(result.context.messages[3].toolName, result.context.tools[0].name);
  assert.deepEqual(result.toolMap.get(result.context.tools[0].name), { name: 'exec_command', namespace: 'functions' });
});

test('rejects unsupported inputs, broken tool history and altered reasoning', () => {
  for (const extra of [{ tools: [{ type: 'web_search' }] }, { previous_response_id: 'old' }, { input: [{ type: 'compaction' }] }, { input: [{ type: 'function_call_output', call_id: 'missing', output: '' }] }, { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'http://localhost/private' }] }] }]) {
    assert.throws(() => translate({ model: modelId, ...extra }, model, codec));
  }
  const encrypted = codec.seal({ type: 'thinking', thinking: 'secret', thinkingSignature: 'signature' }, modelId);
  assert.equal(codec.open(encrypted).model, modelId);
  assert.throws(() => codec.open(encrypted.slice(0, -5) + 'xxxxx'));
});

test('authenticates all endpoints and reports malformed input before inference', async t => {
  let calls = 0;
  const { url, request } = await start(t, () => { calls++; });
  assert.equal((await fetch(url + '/health')).status, 401);
  assert.equal((await request({ input: [{ type: 'compaction' }] })).status, 400);
  assert.equal(calls, 0);
});

test('streams text before completion and counts cached input tokens', async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const { request } = await start(t, async function* (_model, context, options) {
    assert.equal(options.reasoning, 'medium');
    assert.equal(context.messages[0].content[0].text, 'Hi');
    const partial = assistant([{ type: 'text', text: '' }]);
    yield { type: 'start', partial };
    yield { type: 'text_start', contentIndex: 0, partial };
    partial.content[0].text = 'hello';
    yield { type: 'text_delta', contentIndex: 0, delta: 'hello', partial };
    await pending;
    yield { type: 'text_end', contentIndex: 0, partial };
    yield { type: 'done', reason: 'stop', message: partial };
  });
  const response = await request({ stream: true });
  const reader = response.body.getReader();
  let text = '';
  while (!text.includes('response.output_text.delta')) text += new TextDecoder().decode((await reader.read()).value);
  assert.ok(!text.includes('response.completed'));
  finish();
  while (true) { const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value); }
  const data = events(text);
  assert.equal(data.at(-1).type, 'response.completed');
  assert.equal(data.at(-1).response.usage.input_tokens, 35);
  assert.equal(data.at(-1).response.usage.total_tokens, 40);
  assert.deepEqual(data.map(event => event.sequence_number), data.map((_, index) => index));
});

test('custom calls and signed reasoning survive a complete response and replay', async t => {
  const tools = [{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'apply_patch' }] }];
  const { request } = await start(t, async function* (_model, context) {
    const partial = assistant([{ type: 'thinking', thinking: 'plan', thinkingSignature: 'late-signature' }, { type: 'toolCall', id: 'call_patch', name: context.tools[0].name, arguments: { input: 'patch content' } }]);
    yield { type: 'start', partial };
    yield { type: 'done', reason: 'toolUse', message: partial };
  });
  const response = await request({ tools, stream: true });
  const data = events(await response.text());
  const output = data.at(-1).response.output;
  assert.equal(output[1].type, 'custom_tool_call');
  assert.equal(output[1].namespace, 'functions');
  assert.equal(output[1].input, 'patch content');
  const replay = translate({ model: modelId, tools, input: [...output, { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'ok' }] }, model, codec);
  assert.equal(replay.context.messages[0].content[0].thinkingSignature, 'late-signature');
  assert.equal(replay.context.messages[1].role, 'toolResult');
});

test('disconnect cancels provider work', async t => {
  let canceled;
  const signalSeen = new Promise(resolve => { canceled = resolve; });
  const { request } = await start(t, async function* (_model, _context, options) {
    yield { type: 'start', partial: assistant([]) };
    await new Promise(resolve => options.signal.addEventListener('abort', () => { canceled(); resolve(); }, { once: true }));
  });
  const response = await request({ stream: true });
  await response.body.cancel();
  await Promise.race([signalSeen, new Promise((_, reject) => setTimeout(() => reject(new Error('No cancellation')), 1500).unref())]);
});

test('length limits are not reported as successful complete responses', async t => {
  const { request } = await start(t, async function* () { yield { type: 'done', reason: 'length', message: assistant([{ type: 'text', text: 'partial' }]) }; });
  const data = events(await (await request({ stream: true })).text());
  assert.equal(data.at(-1).type, 'response.incomplete');
  assert.equal(data.at(-1).response.incomplete_details.reason, 'max_output_tokens');
});

test('provider errors use the response.failed event Codex understands', async t => {
  const { request } = await start(t, async function* () { yield { type: 'error', error: { errorMessage: '400 invalid_request: rejected' } }; });
  const data = events(await (await request({ stream: true })).text());
  assert.equal(data.at(-1).type, 'response.failed');
  assert.equal(data.at(-1).response.error.code, 'invalid_prompt');
  assert.match(data.at(-1).response.error.message, /rejected/);
});

test('thinking completes before tool calls, and replay preserves the original model after a switch', async t => {
  const tools = [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }];
  const { request } = await start(t, async function* (_model, context) {
    const partial = assistant([{ type: 'thinking', thinking: '' }]);
    yield { type: 'start', partial };
    yield { type: 'thinking_start', contentIndex: 0, partial };
    partial.content[0] = { type: 'thinking', thinking: 'plan', thinkingSignature: 'signature' };
    yield { type: 'thinking_delta', contentIndex: 0, delta: 'plan', partial };
    yield { type: 'thinking_end', contentIndex: 0, partial };
    partial.content.push({ type: 'toolCall', name: context.tools[0].name, id: 'c1', arguments: {} });
    yield { type: 'toolcall_start', contentIndex: 1, partial };
    yield { type: 'toolcall_end', contentIndex: 1, partial };
    yield { type: 'done', reason: 'toolUse', message: partial };
  });
  const data = events(await (await request({ tools, stream: true, reasoning: { summary: 'none' } })).text());
  const completed = data.filter(event => event.type === 'response.output_item.done').map(event => event.item);
  assert.deepEqual(completed.map(item => item.type), ['reasoning', 'function_call']);
  assert.equal(data.some(event => event.type.startsWith('response.reasoning_summary')), false);
  assert.deepEqual(completed[0].summary, []);
  const switched = { ...model, id: 'claude-other' };
  const replay = translate({ model: 'anthropic/claude-other', tools, input: [...completed.reverse(), { type: 'function_call_output', call_id: 'c1', output: 'ok' }] }, switched, codec);
  assert.equal(replay.context.messages[0].model, 'claude-test');
  assert.equal(replay.context.messages[0].content[0].type, 'thinking');
});

test('streams a custom tool input before toolcall_end without duplicating the prefix', async t => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const tools = [{ type: 'custom', name: 'apply_patch' }];
  const { request } = await start(t, async function* (_model, context) {
    const partial = assistant([{ type: 'toolCall', name: context.tools[0].name, id: 'custom1', arguments: {} }]);
    yield { type: 'start', partial };
    yield { type: 'toolcall_start', contentIndex: 0, partial };
    partial.content[0].arguments = { input: 'first line\n' };
    yield { type: 'toolcall_delta', contentIndex: 0, delta: '', partial };
    await hold;
    partial.content[0].arguments = { input: 'first line\nlast line' };
    yield { type: 'toolcall_end', contentIndex: 0, partial };
    yield { type: 'done', reason: 'toolUse', message: partial };
  });
  const response = await request({ tools, stream: true });
  const reader = response.body.getReader(); let text = '';
  while (!text.includes('response.custom_tool_call_input.delta')) text += new TextDecoder().decode((await reader.read()).value);
  assert.ok(!text.includes('response.completed'));
  release();
  while (true) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value); }
  const deltas = events(text).filter(event => event.type === 'response.custom_tool_call_input.delta');
  assert.equal(deltas.map(event => event.delta).join(''), 'first line\nlast line');
});
