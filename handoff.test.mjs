import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandoff, parseSwitch, projectRollout } from './handoff.mjs';

const sourceId = '11111111-1111-4111-8111-111111111111';
const targetId = '22222222-2222-4222-8222-222222222222';
const message = (role, text) => ({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] });
const row = payload => ({ type: 'response_item', payload });
const event = type => ({ type: 'event_msg', payload: { type } });
const rollout = (items = [], cwd = '/tmp') => Buffer.from([
  { type: 'session_meta', payload: { id: sourceId, cwd, model_provider: 'pi_claude' } },
  row(message('user', 'Preserve the work.')), ...items,
].map(item => JSON.stringify(item)).join('\n') + '\n');

test('switch commands take only an explicit session UUID', () => {
  assert.deepEqual(parseSwitch(['switch-to-codex', sourceId]), { destination: 'codex', sourceId });
  assert.deepEqual(parseSwitch(['switch-to-claude', sourceId]), { destination: 'claude', sourceId });
  assert.equal(parseSwitch(['resume', sourceId]), null);
  for (const args of [['switch-to-codex'], ['switch-to-claude', '../history'], ['switch-to-codex', sourceId, '-m', 'other']]) assert.throws(() => parseSwitch(args), /Usage/);
});

test('shared state retains messages, readable reasoning, images and tool evidence without opaque state', () => {
  const raw = rollout([
    row(message('developer', 'Old provider instructions')),
    { type: 'world_state', payload: { state: {} } },
    row({ type: 'reasoning', encrypted_content: 'pi1.secret', summary: [{ type: 'summary_text', text: 'Check the tests first.' }] }),
    row({ type: 'function_call', call_id: 'call1', name: 'exec_command', arguments: '{"cmd":"npm test"}', encrypted_function_args: ['private'] }),
    row({ type: 'function_call_output', call_id: 'call1', output: { content: [{ type: 'input_text', text: '13 passed' }, { type: 'encrypted_content', encrypted_content: 'opaque' }] } }),
    row({ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,YQ==' }] }),
    row(message('assistant', 'Tests passed.')),
  ]);
  const state = projectRollout(raw, sourceId);
  const out = JSON.stringify(state.items);
  assert.match(out, /Check the tests first/);
  assert.match(out, /13 passed/);
  assert.match(out, /Tests passed/);
  assert.match(out, /data:image\/png;base64/);
  assert.doesNotMatch(out, /pi1.secret|private|opaque|Old provider instructions/);
  assert.equal(state.counts.toolRecords, 2);
  assert.equal(state.counts.opaqueFields, 3);
  assert.equal(state.counts.sourceInstructions, 1);
  assert.ok(state.items.every(item => item.type === 'message'));
});

test('rejects partial, ambiguous, unsupported and rolled-back histories', () => {
  for (const rows of [
    [event('task_started')],
    [row({ type: 'function_call', call_id: 'a', name: 'shell', arguments: '{}' })],
    [row({ type: 'function_call_output', call_id: 'missing', output: 'result' })],
    [event('thread_rolled_back')],
    [row({ type: 'future_item' })],
    [row({ type: 'message', role: 'user', content: [{ type: 'input_audio', audio_url: 'data:audio/foo' }] })],
    [row({ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/private.png' }] })],
    [{ type: 'future_record' }],
  ]) assert.throws(() => projectRollout(rollout(rows), sourceId));
  assert.throws(() => projectRollout(rollout(), targetId), /ID/);
  assert.throws(() => projectRollout(Buffer.from('{bad'), sourceId), /invalid JSON/);
  assert.doesNotThrow(() => projectRollout(rollout([event('task_started'), event('task_complete')]), sourceId));
});

test('compaction preserves available full history and readable summaries, not provider blobs', () => {
  const state = projectRollout(rollout([
    row(message('assistant', 'Original decision')),
    { type: 'compacted', payload: { message: 'The decision was verified.' } },
    row({ type: 'compaction', encrypted_content: 'secret' }),
    row(message('user', 'Continue')),
  ]), sourceId);
  const text = JSON.stringify(state.items);
  assert.match(text, /Original decision/);
  assert.match(text, /decision was verified/);
  assert.match(text, /Continue/);
  assert.doesNotMatch(text, /secret/);
});

test('repeated projections retain compatible history without reintroducing reasoning blobs', () => {
  const first = projectRollout(rollout([row({ type: 'reasoning', encrypted_content: 'claude', summary: [] }), row(message('assistant', 'Claude answer'))]), sourceId);
  const second = projectRollout(rollout([...first.items.map(row), row({ type: 'reasoning', encrypted_content: 'openai', summary: [] }), row(message('assistant', 'OpenAI answer'))]), sourceId);
  assert.match(JSON.stringify(second.items), /Claude answer/);
  assert.match(JSON.stringify(second.items), /OpenAI answer/);
  assert.ok(second.items.every(item => item.type === 'message'));
});

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-handoff-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'source.jsonl');
  const raw = rollout(options.rows, dir);
  await writeFile(path, raw);
  const requests = [];
  let closed = false;
  const client = {
    async initialize() {},
    async close() { closed = true; },
    async call(method, params) {
      requests.push({ method, params });
      if (method === 'thread/read') return { thread: { id: sourceId, path, cwd: dir, status: { type: options.active ? 'active' : 'notLoaded' }, historyMode: options.historyMode ?? 'legacy' } };
      if (method === 'thread/start') return { thread: { id: targetId, modelProvider: options.provider ?? 'openai' }, model: 'configured-default', reasoningEffort: 'high' };
      if (method === 'thread/inject_items' && options.failInject) throw new Error('injection failed');
      if (method === 'thread/inject_items' && options.mutate) await writeFile(path, Buffer.concat([raw, Buffer.from('\n')]));
      return {};
    },
  };
  const run = () => createHandoff({ sourceId, destination: options.destination ?? 'codex', stateDir: dir, makeClient: () => client });
  return { dir, path, raw, requests, run, closed: () => closed };
}

test('handoff archives original bytes privately and uses destination defaults without inference', async t => {
  const f = await fixture(t);
  const receipt = await f.run();
  assert.equal(receipt.destinationId, targetId);
  assert.equal(receipt.model, 'configured-default');
  assert.deepEqual(await readFile(f.path), f.raw);
  assert.deepEqual(await readFile(join(receipt.archiveDir, 'source.jsonl')), f.raw);
  assert.equal((await stat(receipt.archiveDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(receipt.archiveDir, 'source.jsonl'))).mode & 0o777, 0o600);
  assert.deepEqual(f.requests.find(r => r.method === 'thread/start').params, { cwd: f.dir, ephemeral: false });
  assert.ok(!f.requests.some(r => r.method === 'turn/start' || r.method === 'thread/resume'));
  assert.ok(f.closed());
});

test('Claude handoff checks that the bridge configuration is active', async t => {
  const f = await fixture(t, { destination: 'claude', provider: 'pi_claude' });
  assert.equal((await f.run()).provider, 'pi_claude');
  const wrong = await fixture(t, { destination: 'claude', provider: 'openai' });
  await assert.rejects(wrong.run(), /wrong provider/);
  assert.ok(!wrong.requests.some(r => r.method === 'thread/inject_items'));
});

test('failures never launch a continuation and retain the original', async t => {
  for (const options of [{ active: true }, { historyMode: 'unknown' }, { failInject: true }, { mutate: true }]) {
    const f = await fixture(t, options);
    await assert.rejects(f.run());
    assert.ok(f.closed());
    if (!options.mutate) assert.deepEqual(await readFile(f.path), f.raw);
    if (options.active || options.historyMode) assert.ok(!f.requests.some(r => r.method === 'thread/start'));
  }
});
