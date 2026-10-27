import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fromResponses, fromAnthropic, fromTranscript, restoreSource, toOpenAI, toAnthropic } from './history.mjs';
import { createCodec } from './bridge.mjs';

const model = { provider: 'anthropic', id: 'claude-test', api: 'anthropic-messages' };
const codec = createCodec(randomBytes(32));
const serialize = value => JSON.parse(JSON.stringify(value));

test('inline tool declarations survive canonical and OpenAI replay without becoming Claude messages', () => {
  const input = [{ type: 'additional_tools', id: 'at_saved', role: 'developer', extra: true,
    tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }] },
  { role: 'user', content: 'Continue' }];
  const canonical = serialize(fromResponses(input));
  assert.equal(canonical.entries[0].kind, 'tool_definitions');
  assert.deepEqual(toOpenAI(canonical)[0], input[0]);
  assert.deepEqual(toAnthropic(canonical, model).map(message => message.content), [[{ type: 'text', text: 'Continue' }]]);
  canonical.entries[0].tools[0].name = 'updated';
  assert.equal(toOpenAI(canonical)[0].tools[0].name, 'updated');
  assert.deepEqual(restoreSource(canonical), input);
  assert.throws(() => fromResponses([{ type: 'additional_tools' }]), /Additional tools must be an array/);
  assert.throws(() => toAnthropic(fromResponses([{ type: 'unknown_artifact' }]), model), /Unsupported input item/);
});

test('Claude groups late parallel results with their calls across user steering and later assistant turns', () => {
  const call = id => ({ type: 'function_call', call_id: id, name: 'write_stdin', arguments: '{}' });
  const result = id => ({ type: 'function_call_output', call_id: id, output: `result ${id}` });
  const input = [call('a'), call('b'), { role: 'user', content: 'New instruction' },
    result('b'), { role: 'developer', content: 'Keep constraints' },
    { role: 'assistant', content: 'Update' }, call('c'), result('c'), result('a'),
    { role: 'user', content: 'Continue' }];
  const canonical = fromResponses(input);
  const before = serialize(canonical);
  const projected = toAnthropic(canonical, model, { codec });
  assert.deepEqual(projected.map(message => message.role === 'toolResult' ? message.toolCallId : message.role),
    ['assistant', 'b', 'a', 'user', 'system', 'assistant', 'c', 'user']);
  assert.deepEqual(projected[1].content, [{ type: 'text', text: 'result b' }]);
  assert.deepEqual(projected[2].content, [{ type: 'text', text: 'result a' }]);
  assert.deepEqual(canonical, before);
  assert.deepEqual(restoreSource(canonical), input);
});

test('Claude rejects ambiguous repeated tool IDs and duplicate results before inference', () => {
  const call = { type: 'function_call', call_id: 'a', name: 'write_stdin', arguments: '{}' };
  const result = { type: 'function_call_output', call_id: 'a', output: 'done' };
  assert.throws(() => toAnthropic(fromResponses([call, call]), model), /Duplicate tool call ID/);
  assert.throws(() => toAnthropic(fromResponses([call, result, result]), model), /Duplicate tool result/);
});

test('Responses import is lossless after canonical serialization, including native fields and unknown artifacts', () => {
  const source = [
    { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Answer', annotations: [{ type: 'citation', url: 'https://example.com' }] }], status: 'completed', phase: 'final_answer' },
    { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Plan', extra: true }], encrypted_content: 'openai-secret', unknown: { nested: 1 } },
    { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_1', name: 'apply_patch', namespace: 'functions', input: 'patch', encrypted_function_args: ['opaque'] },
    { type: 'custom_tool_call_output', call_id: 'call_1', output: 'done' },
    { type: 'compaction', encrypted_content: 'opaque-compaction', vendor_state: { cursor: 2 } },
    { type: 'future_provider_record', opaque: ['everything', 'retained'] },
  ];
  const canonical = serialize(fromResponses(source));
  assert.deepEqual(restoreSource(canonical), source);
  assert.deepEqual(toOpenAI(canonical), source);
  assert.equal(canonical.entries[2].arguments.encoding, 'text');
  assert.equal(canonical.entries[2].callId, canonical.entries[3].callId);
});

test('Anthropic import preserves signatures, redacted reasoning, caller metadata, errors and multimodal content', () => {
  const source = [
    { role: 'user', content: [{ type: 'text', text: 'Inspect this' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } }] },
    { role: 'assistant', id: 'msg_claude', model: 'claude-test', usage: { output_tokens: 15 }, content: [
      { type: 'thinking', thinking: 'Plan', signature: 'signed' }, { type: 'redacted_thinking', data: 'redacted' },
      { type: 'text', text: 'Checking' }, { type: 'tool_use', id: 'toolu_1', name: 'shell', input: { cmd: 'pwd' }, caller: { type: 'direct' } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Denied', is_error: true }] },
  ];
  const canonical = serialize(fromAnthropic(source));
  assert.deepEqual(restoreSource(canonical), source);
  assert.equal(canonical.entries.find(entry => entry.kind === 'tool_result').isError, true);
  const claude = toAnthropic(canonical, model);
  assert.equal(claude[0].content[1].type, 'image');
  assert.ok(claude.some(message => message.content.some(part => part.thinkingSignature === 'signed')));
  assert.ok(claude.some(message => message.content.some(part => part.redacted && part.thinkingSignature === 'redacted')));
  assert.equal(claude.at(-1).isError, true);
  const openai = toOpenAI(canonical);
  assert.doesNotMatch(JSON.stringify(openai), /"signed"|"redacted"/);
  assert.match(JSON.stringify(openai), /Plan/);
  assert.match(JSON.stringify(openai), /This tool execution failed/);
  assert.equal(openai.find(item => item.type === 'function_call').call_id, 'toolu_1');
});

test('both adapters read canonical fields rather than treating a native payload as authoritative', () => {
  const source = [
    { role: 'user', content: 'Before' },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'shell', arguments: '{"cmd":"pwd"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'Before' },
  ];
  const canonical = fromResponses(source);
  canonical.entries[0].content[0].text = 'After';
  canonical.entries[1].arguments.value = '{"cmd":"ls"}';
  canonical.entries[2].content[0].text = 'After';
  const openai = toOpenAI(canonical);
  assert.equal(openai[0].content[0].text, 'After');
  assert.equal(openai[1].arguments, '{"cmd":"ls"}');
  assert.equal(openai[2].output, 'After');
  const claude = toAnthropic(canonical, model);
  assert.equal(claude[0].content[0].text, 'After');
  assert.equal(claude[1].content[0].arguments.cmd, 'ls');
  assert.equal(claude[2].content[0].text, 'After');
  assert.deepEqual(restoreSource(canonical), source);
});

test('mixed canonical history retains both native states across serialization and repeated projection', () => {
  const signed = { type: 'thinking', thinking: 'Claude plan', thinkingSignature: 'claude-signature' };
  const source = [
    { type: 'reasoning', id: 'rs_claude', summary: [{ type: 'summary_text', text: 'Claude plan' }], encrypted_content: codec.seal(signed, 'anthropic/claude-test') },
    { role: 'assistant', content: 'Claude answer' }, { role: 'user', content: 'Next' },
    { type: 'reasoning', id: 'rs_openai', summary: [{ type: 'summary_text', text: 'OpenAI plan' }], encrypted_content: 'openai-signature' },
    { role: 'assistant', content: 'OpenAI answer' },
  ];
  const canonical = serialize(fromResponses(source));
  const before = serialize(canonical);
  for (let iteration = 0; iteration < 3; iteration++) {
    const openai = toOpenAI(canonical);
    assert.doesNotMatch(JSON.stringify(openai), /pi1\./);
    assert.match(JSON.stringify(openai), /openai-signature/);
    const claude = toAnthropic(canonical, model, { codec });
    assert.match(JSON.stringify(claude), /claude-signature/);
    assert.doesNotMatch(JSON.stringify(claude), /openai-signature/);
    assert.match(JSON.stringify(claude), /OpenAI answer/);
  }
  assert.deepEqual(canonical, before);
  assert.deepEqual(restoreSource(canonical), source);
});

test('canonical identities survive appended turns and distinguish repeated records', () => {
  const item = { role: 'user', content: 'Again' };
  const first = fromResponses([item, item]);
  const next = fromResponses([item, item, { role: 'assistant', content: 'New answer' }]);
  assert.notEqual(first.entries[0].id, first.entries[1].id);
  assert.deepEqual(next.entries.slice(0, 2).map(entry => entry.id), first.entries.map(entry => entry.id));
});

test('clearing canonical state and namespaces cannot resurrect native values', () => {
  const canonical = fromResponses([
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'original' },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', namespace: 'functions', name: 'shell', arguments: '{}' },
  ]);
  canonical.entries[0].state.value = null;
  canonical.entries[1].namespace = null;
  canonical.entries[1].arguments = { encoding: 'text', value: 'raw input' };
  const projected = toOpenAI(canonical);
  assert.equal('encrypted_content' in projected[0], false);
  assert.equal('namespace' in projected[1], false);
  assert.equal('arguments' in projected[1], false);
  assert.equal(projected[1].input, 'raw input');
  assert.match(projected[1].id, /^ctc_/);
});

test('content metadata follows its original part and cannot leak across replacement content', () => {
  const canonical = fromResponses([{ role: 'user', content: [
    { type: 'input_text', text: 'First', annotations: ['first'] },
    { type: 'input_text', text: 'Second', annotations: ['second'] },
    { type: 'input_image', image_url: 'data:image/png;base64,YQ==', detail: 'high' },
  ] }]);
  const parts = canonical.entries[0].content;
  canonical.entries[0].content = [parts[1], parts[0], { ...parts[2], kind: 'text', text: 'Replaced image' }];
  const projected = toOpenAI(canonical)[0].content;
  assert.deepEqual(projected[0].annotations, ['second']);
  assert.deepEqual(projected[1].annotations, ['first']);
  assert.deepEqual(projected[2], { type: 'input_text', text: 'Replaced image' });
  canonical.entries[0].content[0].text = 'Changed text';
  assert.equal('annotations' in toOpenAI(canonical)[0].content[0], false);
});

test('reasoning projection validates authoritative ciphertext even after import with a codec', () => {
  const source = [{ type: 'reasoning', summary: [], encrypted_content: codec.seal({ type: 'thinking', thinking: 'Plan', thinkingSignature: 'signature' }, 'anthropic/claude-test') }];
  const canonical = fromResponses(source, { codec });
  assert.throws(() => toAnthropic(canonical, model), /original bridge key/);
  canonical.entries[0].state.value = 'pi1.corrupted';
  assert.throws(() => toAnthropic(canonical, model, { codec }), /Cannot restore/);
  canonical.entries[0].state.value = source[0].encrypted_content;
  canonical.entries[0].state.model = 'anthropic/different-model';
  assert.throws(() => toAnthropic(canonical, model, { codec }), /does not match/);
});

test('archives retain exact source bytes, branches, compactions and lifecycle metadata', () => {
  const codex = [
    { type: 'session_meta', payload: { id: 'session', cwd: '/tmp', model_provider: 'openai' } },
    { type: 'response_item', payload: { role: 'user', content: 'Question' } },
    { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn' } },
    { type: 'compacted', payload: { message: 'Summary', replacement_history: [] } },
    { type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } },
    { type: 'future_event', opaque: { retained: true } },
  ];
  const claude = [
    { type: 'assistant', uuid: 'message', parentUuid: 'parent', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'Branch answer' }] } },
    { type: 'file-history-snapshot', snapshot: { files: ['path'] } },
    { type: 'system', subtype: 'compact_boundary', content: 'Summary' },
  ];
  for (const [format, records] of [['codex-jsonl', codex], ['claude-code-jsonl', claude]]) {
    const text = records.map(record => JSON.stringify(record)).join('\r\n') + '\r\n\n';
    const canonical = serialize(fromTranscript(format, text));
    assert.equal(restoreSource(canonical), text);
    assert.deepEqual(canonical.records.map(record => record.metadata), records);
    assert.throws(() => toOpenAI(canonical), /active request history/);
    assert.throws(() => toAnthropic(canonical, model), /active request history/);
  }
});

test('unsupported content is retained canonically and rejected by an incompatible adapter', () => {
  const source = [{ role: 'user', content: [{ type: 'document', source: { type: 'file', file_id: 'private' }, future: true }] }];
  const canonical = serialize(fromAnthropic(source));
  assert.deepEqual(restoreSource(canonical), source);
  assert.throws(() => toOpenAI(canonical), /without losing information/);
  assert.throws(() => toAnthropic(canonical, model), /Unsupported message content/);
});
