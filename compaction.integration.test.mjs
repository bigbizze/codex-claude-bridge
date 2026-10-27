import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { AppServer } from './app-server.mjs';
import { createBridge, createCodec, catalog } from './bridge.mjs';
import { mergeCatalogs } from './model-catalog.mjs';
import { createSelectedModelReader } from './compaction.mjs';

test('real Codex resumes an oversized Claude thread, recovers compaction 429 on GPT, then answers on GPT',
  { skip: process.env.CODEX_ROUTING_INTEGRATION !== '1', timeout: 60000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-compaction-integration-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'test-openai-key' }), { mode: 0o600 });
    const env = { ...process.env, CODEX_HOME: dir, CODEX_PI_BRIDGE_TOKEN: 'local-token' };
    const native = JSON.parse(execFileSync('codex', ['debug', 'models', '--bundled'], { env, encoding: 'utf8' }));
    const openaiModel = (Array.isArray(native) ? native : native.models).find(entry => entry.slug === 'gpt-6-astra');
    assert.ok(openaiModel);
    const model = { provider: 'anthropic', id: 'claude-test', api: 'anthropic-messages', contextWindow: 1000000, input: ['text'], reasoning: true };
    const modelId = 'anthropic/claude-test';
    const claudeRequests = [];
    const openaiRequests = [];
    const selections = [];
    const reader = createSelectedModelReader(dir);
    const bridge = createBridge({ token: 'local-token', codec: createCodec(randomBytes(32)),
      selectedModel: async identity => { const selected = await reader(identity); selections.push({ identity, selected }); return selected; },
      registry: { getAvailable: () => [model], async *streamSimple(_model, context) {
        claudeRequests.push(context);
        if (claudeRequests.length > 1) {
          yield { type: 'error', error: { errorMessage: '429 rate_limit_error: Anthropic quota exhausted' } };
          return;
        }
        yield { type: 'done', reason: 'stop', message: { content: [{ type: 'text', text: 'Remembered BLUEBIRD-42.' }],
          usage: { input: 300000, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 300005 } } };
      } },
      openai: { catalog: { models: [openaiModel] }, fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body);
        openaiRequests.push(request);
        const item = { type: 'message', id: `msg_${openaiRequests.length}`, role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'BLUEBIRD-42 preserved on GPT.', annotations: [] }] };
        const response = { id: `resp_${openaiRequests.length}`, object: 'response', model: request.model, status: 'completed', output: [item],
          usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } };
        const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
          { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response }];
        return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
      } },
    });
    bridge.server.listen(0, '127.0.0.1'); await once(bridge.server, 'listening');
    t.after(() => bridge.close());
    const catalogFile = join(dir, 'models.json');
    await writeFile(catalogFile, JSON.stringify(mergeCatalogs(catalog([model]), { models: [openaiModel] })));
    const args = ['--no-daemon', '-c', 'model_provider="pi_claude"', '-c', 'model_providers.pi_claude.name="Pi Claude"',
      '-c', `model_providers.pi_claude.base_url="http://127.0.0.1:${bridge.server.address().port}/v1"`,
      '-c', 'model_providers.pi_claude.wire_api="responses"', '-c', 'model_providers.pi_claude.requires_openai_auth=true',
      '-c', 'model_providers.pi_claude.supports_websockets=false',
      '-c', 'model_providers.pi_claude.env_http_headers={"x-codex-bridge-token"="CODEX_PI_BRIDGE_TOKEN"}',
      '-c', `model_catalog_json=${JSON.stringify(catalogFile)}`, '-c', `model=${JSON.stringify(modelId)}`,
      '-c', 'web_search="disabled"', '-c', 'model_auto_compact_token_limit=500000',
      '-c', 'model_auto_compact_token_limit_scope="total"', '-c', 'cli_auth_credentials_store="file"'];
    let client = new AppServer(args, { env, cwd: dir });
    t.after(() => client.close());
    await client.initialize();
    const source = (await client.call('thread/start', { cwd: dir })).thread;
    const runTurn = async model => {
      let timer;
      let onLine;
      const completed = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Compaction turn timed out')), 20000);
        onLine = line => { const message = JSON.parse(line); if (message.method === 'turn/completed') resolve(message.params.turn); };
        client.lines.on('line', onLine);
      });
      try {
        await client.call('turn/start', { threadId: source.id, model, input: [{ type: 'text', text: 'Remember BLUEBIRD-42. Reply briefly without tools.' }] });
        const turn = await completed;
        assert.equal(turn.status, 'completed', JSON.stringify({ error: turn.error, selections }));
      } finally { clearTimeout(timer); client.lines.off('line', onLine); }
    };
    await runTurn(modelId);
    await client.close();
    client = new AppServer(args, { env, cwd: dir });
    await client.initialize();
    await client.call('thread/resume', { threadId: source.id });
    await runTurn(`openai/${openaiModel.slug}`);
    assert.equal(claudeRequests.length, 2, 'initial turn plus previous-model compaction');
    assert.equal(openaiRequests.length, 2, 'fallback compaction plus requested turn');
    assert.equal(selections[0].selected.model, `openai/${openaiModel.slug}`);
    for (const request of openaiRequests) {
      assert.equal(request.model, openaiModel.slug);
      assert.match(JSON.stringify(request.input), /BLUEBIRD-42/);
    }
    const meta = JSON.parse(openaiRequests[0].client_metadata['x-codex-turn-metadata']);
    assert.equal(meta.request_kind, 'compaction');
    assert.equal(meta.compaction.reason, 'model_downshift');
    await client.close();
    assert.match(await readFile(source.path, 'utf8'), /"type":"compacted"/);
  });
