import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { AppServer } from './app-server.mjs';
import { createBridge, createCodec, catalog } from './bridge.mjs';
import { mergeCatalogs } from './routing.mjs';

for (const authentication of ['api', 'chatgpt']) {
test(`real Codex lists both providers and switches the same persisted thread with ${authentication} authentication`, { skip: process.env.CODEX_ROUTING_INTEGRATION !== '1', timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-routing-integration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const claims = { sub: 'test-user', email: 'test@example.com', exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: 'test-account', chatgpt_user_id: 'test-user', chatgpt_plan_type: 'plus' } };
  const jwt = `${Buffer.from('{"alg":"RS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fake-signature`;
  const auth = authentication === 'api' ? { OPENAI_API_KEY: 'test-openai-key' }
    : { auth_mode: 'chatgpt', tokens: { id_token: jwt, access_token: jwt, refresh_token: 'fake-refresh-token', account_id: 'test-account' }, last_refresh: new Date().toISOString() };
  await writeFile(join(dir, 'auth.json'), JSON.stringify(auth), { mode: 0o600 });
  const env = { ...process.env, CODEX_HOME: dir, CODEX_PI_BRIDGE_TOKEN: 'local-token' };
  const native = JSON.parse(execFileSync('codex', ['debug', 'models', '--bundled'], { env, encoding: 'utf8' }));
  const nativeModels = Array.isArray(native) ? native : native.models;
  const openaiModel = nativeModels.find(entry => entry.slug === 'gpt-6-astra') || nativeModels.find(entry => entry.visibility === 'list');
  assert.ok(openaiModel);
  const model = { provider: 'anthropic', id: 'claude-test', name: 'Test Claude', api: 'anthropic-messages', contextWindow: 1000000, input: ['text'], reasoning: true };
  const modelId = 'anthropic/claude-test';
  const codec = createCodec(randomBytes(32));
  const thinking = { type: 'thinking', thinking: 'Original Claude thought', thinkingSignature: 'original-claude-signature' };
  const claudeRequests = [];
  const openaiRequests = [];
  const usage = { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25 };
  const bridge = createBridge({ token: 'local-token', codec,
    registry: { getAvailable: () => [model], async *streamSimple(_model, context) {
      claudeRequests.push(context);
      yield { type: 'done', reason: 'stop', message: { role: 'assistant', content: [thinking, { type: 'text', text: 'Claude remembers BLUEBIRD-42.' }], usage } };
    } },
    openai: { catalog: { models: [openaiModel] }, fetchImpl: async (url, options) => {
      assert.equal(url, authentication === 'api' ? 'https://api.openai.com/v1/responses' : 'https://chatgpt.com/backend-api/codex/responses');
      assert.equal(options.headers.get('authorization'), `Bearer ${authentication === 'api' ? 'test-openai-key' : jwt}`);
      if (authentication === 'chatgpt') assert.equal(options.headers.get('chatgpt-account-id'), 'test-account');
      assert.equal(options.headers.has('x-codex-bridge-token'), false);
      const request = JSON.parse(options.body);
      for (const item of request.input) {
        if (item.type === 'custom_tool_call' && item.id) assert.match(item.id, /^ctc_/);
      }
      openaiRequests.push(request);
      const suffix = openaiRequests.length;
      const output = [
        { type: 'reasoning', id: `rs_openai_${suffix}`, summary: [{ type: 'summary_text', text: 'OpenAI remembered the marker' }], encrypted_content: `openai-opaque-${suffix}` },
        { type: 'message', id: `msg_openai_${suffix}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OpenAI remembers BLUEBIRD-42.', annotations: [] }] },
      ];
      const response = { id: `resp_openai_${suffix}`, object: 'response', model: request.model, status: 'completed', output, usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } };
      const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }];
      for (const [index, item] of output.entries()) {
        events.push({ type: 'response.output_item.added', output_index: index, item });
        events.push({ type: 'response.output_item.done', output_index: index, item });
      }
      events.push({ type: 'response.completed', response });
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    } },
  });
  bridge.server.listen(0, '127.0.0.1'); await once(bridge.server, 'listening');
  t.after(() => bridge.close());
  const catalogFile = join(dir, 'models.json');
  await writeFile(catalogFile, JSON.stringify(mergeCatalogs(catalog([model]), { models: [openaiModel] })));
  const args = [
    '-c', 'model_provider="pi_claude"', '-c', 'model_providers.pi_claude.name="Pi Claude"',
    '-c', `model_providers.pi_claude.base_url="http://127.0.0.1:${bridge.server.address().port}/v1"`,
    '-c', 'model_providers.pi_claude.wire_api="responses"', '-c', 'model_providers.pi_claude.requires_openai_auth=true',
    '-c', 'model_providers.pi_claude.supports_websockets=false',
    '-c', 'model_providers.pi_claude.env_http_headers={"x-codex-bridge-token"="CODEX_PI_BRIDGE_TOKEN"}',
    '-c', `model_catalog_json=${JSON.stringify(catalogFile)}`, '-c', `model=${JSON.stringify(modelId)}`,
    '-c', 'web_search="disabled"', '-c', 'model_reasoning_effort="medium"', '-c', 'cli_auth_credentials_store="file"',
  ];
  let client = new AppServer(args, { env, cwd: dir });
  t.after(() => client.close());
  await client.initialize();
  const models = await client.call('model/list', {});
  assert.ok(models.data.some(entry => entry.model === modelId));
  assert.ok(models.data.some(entry => entry.model === openaiModel.slug));
  const source = (await client.call('thread/start', { cwd: dir })).thread;
  await client.call('thread/inject_items', { threadId: source.id, items: [
    { type: 'custom_tool_call', id: 'fc_legacy_bridge_patch', call_id: 'legacy_patch', name: 'apply_patch', namespace: 'functions', input: 'Historical patch, already applied' },
    { type: 'custom_tool_call_output', call_id: 'legacy_patch', output: 'Historical patch completed' },
  ] });
  for (const [index, selected] of [modelId, openaiModel.slug, openaiModel.slug, modelId].entries()) {
    if (index === 3) {
      await client.close();
      client = new AppServer(args, { env, cwd: dir });
      await client.initialize();
      await client.call('thread/resume', { threadId: source.id });
    }
    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { client.lines.off('line', onLine); reject(new Error(`Turn ${index} did not complete`)); }, 20000);
      const onLine = line => {
        const message = JSON.parse(line);
        if (message.method === 'turn/completed') {
          clearTimeout(timer); client.lines.off('line', onLine); resolve(message.params.turn);
        }
      };
      client.lines.on('line', onLine);
    });
    await client.call('turn/start', { threadId: source.id, model: selected, input: [{ type: 'text', text: index === 0 ? 'Remember BLUEBIRD-42. Reply briefly without tools.' : 'Recall the marker. Reply briefly without tools.' }] });
    const turn = await completed;
    assert.equal(turn.status, 'completed', JSON.stringify(turn.error));
  }
  assert.equal(claudeRequests.length, 2);
  assert.equal(openaiRequests.length, 2);
  for (const request of openaiRequests) {
    assert.equal(request.model, openaiModel.slug);
    assert.match(JSON.stringify(request.input), /BLUEBIRD-42/);
    assert.doesNotMatch(JSON.stringify(request.input), /pi1\./);
    assert.equal(request.input.find(item => item.call_id === 'legacy_patch' && item.type === 'custom_tool_call').id, 'ctc_legacy_bridge_patch');
  }
  assert.match(JSON.stringify(openaiRequests[1].input), /openai-opaque-1/);
  assert.match(JSON.stringify(claudeRequests[1]), /original-claude-signature/);
  assert.match(JSON.stringify(claudeRequests[1]), /OpenAI remembers BLUEBIRD-42/);
  assert.doesNotMatch(JSON.stringify(claudeRequests[1]), /openai-opaque/);
  await client.close();
  const saved = await readFile(source.path, 'utf8');
  assert.match(saved, /pi1\./);
  assert.match(saved, /openai-opaque-1/);
  assert.match(saved, /openai-opaque-2/);
  assert.match(saved, /fc_legacy_bridge_patch/);
});
}
