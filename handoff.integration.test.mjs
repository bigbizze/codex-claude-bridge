import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServer } from './app-server.mjs';
import { createHandoff } from './handoff.mjs';

// Real Codex, isolated configuration, loopback-only mock inference. No account is used.
test('Codex persists, resumes and sends both directions of a handoff', { skip: process.env.CODEX_HANDOFF_INTEGRATION !== '1', timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-handoff-integration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(request);
    const response = { id: 'resp_test', object: 'response', status: 'completed', model: request.model,
      output: [{ type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Destination verified.', annotations: [] }] }],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: response.output[0] },
      { type: 'response.output_text.delta', item_id: 'msg_test', output_index: 0, content_index: 0, delta: 'Destination verified.' },
      { type: 'response.output_item.done', output_index: 0, item: response.output[0] },
      { type: 'response.completed', response },
    ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { ...process.env, CODEX_HOME: dir };
  const argsFor = provider => [
    '-c', `model_provider="${provider}"`, '-c', `model_providers.${provider}.name="Mock ${provider}"`,
    '-c', `model_providers.${provider}.base_url="http://127.0.0.1:${server.address().port}/v1"`,
    '-c', `model_providers.${provider}.wire_api="responses"`, '-c', `model_providers.${provider}.supports_websockets=false`,
    '-c', `model="${provider}-default"`, '-c', 'model_reasoning_effort="high"',
    '-c', 'web_search="disabled"',
  ];
  const sourceClient = new AppServer(argsFor('pi_claude'), { env, cwd: dir });
  let source;
  try {
    await sourceClient.initialize();
    source = (await sourceClient.call('thread/start', { cwd: dir })).thread;
    await sourceClient.call('thread/inject_items', { threadId: source.id, items: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Keep the special marker BLUEBIRD-42.' }] },
      { type: 'reasoning', summary: [], encrypted_content: 'pi1.only-the-source-can-read-this' },
      { type: 'function_call', call_id: 'source_call', name: 'exec_command', arguments: '{"cmd":"npm test"}' },
      { type: 'function_call_output', call_id: 'source_call', output: 'Tests passed: 13' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The marker and test results are recorded.' }] },
    ] });
  } finally { await sourceClient.close(); }
  const original = await readFile(source.path);
  let sourceId = source.id;
  for (const [destination, provider] of [['codex', 'test_codex'], ['claude', 'pi_claude']]) {
    const args = argsFor(provider);
    const result = await createHandoff({ sourceId, destination, args, env, stateDir: join(dir, 'bridge') });
    assert.equal(result.provider, provider);
    assert.equal(result.model, `${provider}-default`);
    assert.equal(result.reasoningEffort, 'high');
    const client = new AppServer(args, { env, cwd: dir });
    try {
      await client.initialize();
      await client.call('thread/resume', { threadId: result.destinationId });
      const completed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Mock inference did not complete')), 20000);
        client.lines.on('line', line => {
          const msg = JSON.parse(line);
          if (msg.method === 'turn/completed') { clearTimeout(timer); resolve(msg.params); }
        });
      });
      await client.call('turn/start', { threadId: result.destinationId, input: [{ type: 'text', text: 'Reply briefly without tools.' }] });
      const completion = await completed;
      assert.equal(completion.turn.status, 'completed');
      const request = requests.at(-1);
      assert.equal(request.model, `${provider}-default`);
      assert.match(JSON.stringify(request.input), /BLUEBIRD-42/);
      assert.match(JSON.stringify(request.input), /Tests passed: 13/);
      assert.doesNotMatch(JSON.stringify(request.input), /pi1.only-the-source/);
      assert.ok(!request.input.some(item => item.type === 'function_call'));
      if (destination === 'claude') assert.match(JSON.stringify(request.input), /Destination verified/);
    } finally { await client.close(); }
    sourceId = result.destinationId;
  }
  assert.deepEqual(await readFile(source.path), original);
  assert.equal(requests.length, 2);
});
