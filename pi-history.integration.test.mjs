import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createCodec, translate } from './bridge.mjs';

test('Pi serializes compacted inline tool declarations into Anthropic tools without history artifacts', {
  skip: !process.env.PI_ANTHROPIC_MODULE,
}, async () => {
  const { stream } = await import(pathToFileURL(process.env.PI_ANTHROPIC_MODULE).href);
  const { normalizeContext } = await import(new URL('../utils/transcript.js', pathToFileURL(process.env.PI_ANTHROPIC_MODULE)).href);
  const model = { id: 'claude-test', provider: 'anthropic', api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com', input: ['text'], maxTokens: 4096,
    contextWindow: 200000, reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const { context } = translate({ input: [{ type: 'additional_tools', role: 'developer', tools: [
    { type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec' },
      { type: 'function', name: 'lookup', parameters: { type: 'object', properties: { query: { type: 'string' } } } }] },
  ] }, { role: 'user', content: 'Continue' }] }, model);
  let payload;
  let transported = false;
  const result = await stream(model, normalizeContext(context), {
    client: { messages: { create() { transported = true; throw new Error('Unexpected transport'); } } },
    onPayload(value) { payload = value; throw new Error('Offline inline-tool capture'); },
  }).result();
  assert.equal(transported, false);
  assert.match(result.errorMessage, /Offline inline-tool capture/);
  assert.equal(payload.tools.length, 2);
  assert.deepEqual(payload.tools.map(tool => tool.name), context.tools.map(tool => tool.name));
  assert.deepEqual(payload.tools[0].input_schema.required, ['input']);
  assert.deepEqual(payload.tools[1].input_schema.properties.query, { type: 'string' });
  assert.doesNotMatch(JSON.stringify(payload.messages), /additional_tools/);
});

// Point this at an installed Pi's pi-ai/dist/api/anthropic-messages.js.
// Capture the actual provider payload before transport; no credentials or network.
test('Pi replays an interrupted goal with exactly one result before the pause message', {
  skip: !process.env.PI_ANTHROPIC_MODULE,
}, async () => {
  const { stream } = await import(pathToFileURL(process.env.PI_ANTHROPIC_MODULE).href);
  const model = { id: 'claude-test', provider: 'anthropic', api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com', input: ['text', 'image'], maxTokens: 4096,
    contextWindow: 200000, reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const codec = createCodec(randomBytes(32));
  const pause = '<codex_internal_context source="user_goal">\nUser set goal status: "paused".\n</codex_internal_context>';
  const aborted = '<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>';
  const input = [
    { role: 'user', content: 'Check the running command.' },
    { type: 'reasoning', summary: [], encrypted_content: codec.seal({ type: 'thinking',
      thinking: 'Wait for the command.', thinkingSignature: 'preserved-signature' }, 'anthropic/claude-test') },
    { type: 'function_call', call_id: 'toolu_interrupted', name: 'write_stdin',
      arguments: '{"session_id":123,"yield_time_ms":240000}' },
    { role: 'user', content: pause },
    { type: 'function_call_output', call_id: 'toolu_interrupted', output: 'aborted by user after 64.6s' },
    { role: 'user', content: aborted },
    { role: 'user', content: 'Why was the command slow?' },
  ];
  const original = structuredClone(input);
  const { context } = translate({ input }, model, codec);
  let payload;
  let transported = false;
  const sentinel = 'Stopped after offline payload capture';
  const result = await stream(model, context, {
    client: { messages: { create() { transported = true; throw new Error('Unexpected transport'); } } },
    onPayload(value) { payload = value; throw new Error(sentinel); },
  }).result();
  assert.equal(transported, false);
  assert.match(result.errorMessage, new RegExp(sentinel));
  assert.ok(payload);
  const callIndex = payload.messages.findIndex(message => Array.isArray(message.content) &&
    message.content.some(block => block.type === 'tool_use' && block.id === 'toolu_interrupted'));
  assert.ok(callIndex >= 0);
  const results = payload.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(block => block.type === 'tool_result');
  assert.equal(results.length, 1, 'Pi must not synthesize a duplicate result at the pause boundary');
  assert.equal(results[0].tool_use_id, 'toolu_interrupted');
  assert.equal(results[0].content, 'aborted by user after 64.6s');
  assert.equal(payload.messages[callIndex + 1].role, 'user');
  assert.equal(payload.messages[callIndex + 1].content[0], results[0]);
  const remaining = JSON.stringify(payload.messages.slice(callIndex + 2));
  assert.ok(remaining.includes(JSON.stringify(pause).slice(1, -1)));
  assert.ok(remaining.includes(JSON.stringify(aborted).slice(1, -1)));
  assert.match(remaining, /Why was the command slow/);
  assert.match(JSON.stringify(payload.messages[callIndex]), /preserved-signature/);
  assert.deepEqual(input, original, 'Replay must not rewrite the saved history');
});
