import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual, createHash } from 'node:crypto';

export class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const instructions = readFileSync(new URL('./codex-instructions.md', import.meta.url), 'utf8');
const wireName = (name, namespace) => 'tool_' + createHash('sha256').update(JSON.stringify([namespace || null, name])).digest('hex').slice(0, 32);

// Keep provider thinking signatures in encrypted Responses items, including across resume.
export function createCodec(key) {
  return {
    seal(block, model) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const payload = Buffer.concat([cipher.update(JSON.stringify({ model, block })), cipher.final()]);
      return 'pi1.' + Buffer.concat([iv, cipher.getAuthTag(), payload]).toString('base64url');
    },
    open(value) {
      try {
        if (!value?.startsWith('pi1.')) throw new Error();
        const bytes = Buffer.from(value.slice(4), 'base64url');
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(12, 28));
        const data = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]));
        if (typeof data.model !== 'string' || data.block?.type !== 'thinking') throw new Error();
        return data;
      } catch { throw new RequestError('Cannot restore this reasoning item. Use the original bridge key, or start a new conversation.'); }
    },
  };
}

export function catalog(models) {
  return { models: models.map((model, priority) => ({
    slug: `${model.provider}/${model.id}`, display_name: model.name || model.id,
    description: 'Claude through the local Pi bridge',
    default_reasoning_level: model.reasoning ? 'medium' : null,
    supported_reasoning_levels: model.reasoning ? ['low', 'medium', 'high'].filter(level => model.thinkingLevelMap?.[level] !== null).map(effort => ({ effort, description: `${effort} reasoning effort` })) : [],
    shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority,
    availability_nux: null, upgrade: null, model_messages: { instructions_template: instructions },
    include_apps_usage_instructions: false,
    support_verbosity: false, default_verbosity: null,
    apply_patch_tool_type: 'freeform', tool_mode: 'direct',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    context_window: model.contextWindow, max_context_window: model.contextWindow,
    effective_context_window_percent: 90,
    experimental_supported_tools: [], input_modalities: model.input,
    supports_search_tool: false, use_responses_lite: false,
  })) };
}

function parts(value) {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value)) throw new RequestError('Message content must be text or an array.');
  return value.map(part => {
    if (['input_text', 'output_text', 'text'].includes(part.type) && typeof part.text === 'string') return { type: 'text', text: part.text };
    if (part.type === 'input_image') {
      const match = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(part.image_url || '');
      if (!match) throw new RequestError('Images must use base64 data URLs. Remote image URLs and file IDs are not supported.');
      return { type: 'image', mimeType: match[1], data: match[2] };
    }
    throw new RequestError(`Unsupported message content: ${part.type}`);
  });
}

export function translate(request, model, codec) {
  if (request.previous_response_id) throw new RequestError('Send full input history; previous_response_id is not supported.');
  if (request.background) throw new RequestError('Background Responses jobs are not supported.');
  const custom = new Set();
  const toolMap = new Map();
  const flatTools = (request.tools || []).flatMap(tool => tool.type === 'namespace'
    ? tool.tools.map(inner => ({ ...inner, namespace: tool.name })) : [tool]);
  const tools = flatTools.map(tool => {
    if (!['function', 'custom'].includes(tool.type)) throw new RequestError(`Unsupported tool type: ${tool.type}. Disable provider-hosted tools for this bridge.`);
    if (typeof tool.name !== 'string' || !tool.name) throw new RequestError('A tool name is required.');
    const name = wireName(tool.name, tool.namespace);
    if (toolMap.has(name)) throw new RequestError(`Duplicate tool: ${tool.name}`);
    toolMap.set(name, { name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}) });
    if (tool.type === 'custom') custom.add(name);
    return { name, description: tool.description || '', parameters: tool.type === 'custom'
      ? { type: 'object', properties: { input: { type: 'string', description: 'Complete raw input for this tool.' } }, required: ['input'], additionalProperties: false }
      : tool.parameters || { type: 'object', properties: {} } };
  });
  if (request.tool_choice && !['auto', 'none'].includes(request.tool_choice)) throw new RequestError('Only auto and none tool choices are supported.');
  const messages = [];
  const toolNames = new Map();
  const assistant = () => {
    if (messages.at(-1)?.role !== 'assistant') messages.push({ role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage: emptyUsage(), stopReason: 'stop', timestamp: Date.now() });
    return messages.at(-1);
  };
  const input = typeof request.input === 'string' ? [{ role: 'user', content: request.input }] : request.input || [];
  for (const item of input) {
    if (item.type === 'reasoning') {
      if (!item.encrypted_content) throw new RequestError('Reasoning state is missing. Start a new conversation with this bridge.');
      const restored = codec.open(item.encrypted_content);
      const msg = assistant();
      const slash = restored.model.indexOf('/');
      msg.provider = restored.model.slice(0, slash);
      msg.model = restored.model.slice(slash + 1);
      msg.content.push(restored.block);
    } else if (['function_call', 'custom_tool_call'].includes(item.type)) {
      let args;
      try { args = item.type === 'custom_tool_call' ? { input: item.input } : JSON.parse(item.arguments || '{}'); }
      catch { throw new RequestError(`Invalid arguments for ${item.name}`); }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new RequestError('Tool arguments must be a JSON object.');
      const name = wireName(item.name, item.namespace);
      toolNames.set(item.call_id, name);
      const msg = assistant();
      msg.content.push({ type: 'toolCall', id: item.call_id, name, arguments: args });
      msg.stopReason = 'toolUse';
    } else if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) {
      const name = toolNames.get(item.call_id);
      if (!name) throw new RequestError(`No preceding tool call for ${item.call_id}`);
      messages.push({ role: 'toolResult', toolCallId: item.call_id, toolName: name, content: parts(item.output), isError: false, timestamp: Date.now() });
    } else if (item.role === 'assistant') {
      const body = parts(item.content);
      if (body.some(part => part.type !== 'text')) throw new RequestError('Assistant images are not supported.');
      assistant().content.push(...body);
    } else if (item.role === 'system' || item.role === 'developer') {
      const body = parts(item.content);
      if (body.some(part => part.type !== 'text')) throw new RequestError('System messages must be text.');
      messages.push({ role: 'system', content: body, timestamp: Date.now() });
    } else if (item.role === 'user') {
      messages.push({ role: 'user', content: parts(item.content), timestamp: Date.now() });
    } else throw new RequestError(`Unsupported input item: ${item.type}`);
  }
  const effort = request.reasoning?.effort ?? 'medium';
  if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new RequestError(`Unsupported reasoning effort: ${effort}`);
  // Codex persists completed items in event arrival order. Keep signed thinking first
  // even when replaying a conversation created by the earlier bridge.
  for (const message of messages) if (message.role === 'assistant') message.content.sort((a, b) => Number(b.type === 'thinking') - Number(a.type === 'thinking'));
  return { context: { systemPrompt: request.instructions || '', messages, tools }, custom, toolMap,
    options: { reasoning: effort === 'none' ? undefined : effort, toolChoice: request.tool_choice,
      ...(request.max_output_tokens !== undefined ? { maxTokens: request.max_output_tokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}) } };
}

function usage(value) {
  const input = value.input + value.cacheRead + value.cacheWrite;
  return { input_tokens: input, output_tokens: value.output, total_tokens: input + value.output,
    input_tokens_details: { cached_tokens: value.cacheRead },
    output_tokens_details: { reasoning_tokens: value.reasoning || 0 } };
}

function outputItem(block, id, custom, toolMap, codec, model, final, showReasoning) {
  if (block.type === 'text') return { id, type: 'message', role: 'assistant', status: final ? 'completed' : 'in_progress', content: final ? [{ type: 'output_text', text: block.text, annotations: [] }] : [] };
  if (block.type === 'thinking') return { id, type: 'reasoning', summary: final && showReasoning && !block.redacted ? [{ type: 'summary_text', text: block.thinking }] : [], ...(final ? { encrypted_content: codec.seal(block, model) } : {}) };
  if (block.type !== 'toolCall') throw new Error(`Unsupported provider block: ${block.type}`);
  const original = toolMap.get(block.name);
  if (!original) throw new Error(`Provider called an undeclared tool: ${block.name}`);
  if (custom.has(block.name)) return { id, type: 'custom_tool_call', call_id: block.id, ...original, input: final ? String(block.arguments.input ?? '') : '' };
  return { id, type: 'function_call', call_id: block.id, ...original, arguments: final ? JSON.stringify(block.arguments) : '', status: final ? 'completed' : 'in_progress' };
}

function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }

export function createBridge({ registry, token, codec, requestTimeoutMs = 600000 }) {
  const expected = Buffer.from(`Bearer ${token}`);
  const controllers = new Set();
  const server = http.createServer(async (req, res) => {
    const auth = Buffer.from(req.headers.authorization || '');
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return json(res, 401, { error: { message: 'Bridge authentication required.' } });
    const path = new URL(req.url, 'http://localhost').pathname;
    const models = () => registry.getAvailable().filter(model => model.provider === 'anthropic');
    if (req.method === 'GET' && path === '/health') return json(res, 200, { service: 'pi-codex-bridge', version: 2 });
    if (req.method === 'GET' && path === '/v1/models') return json(res, 200, catalog(models()));
    if (req.method !== 'POST' || path !== '/v1/responses') return json(res, 404, { error: { message: 'Unsupported endpoint.' } });
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(new Error('Request timed out.')), requestTimeoutMs);
    const abort = () => { if (!res.writableEnded) controller.abort(new Error('Client disconnected.')); };
    req.on('aborted', abort); res.on('close', abort);
    let heartbeat;
    let sequence = 0;
    const responseId = `resp_${randomUUID()}`;
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) throw new RequestError('Request exceeds 16 MiB.', 413);
        chunks.push(chunk);
      }
      let request;
      try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new RequestError('Invalid JSON.'); }
      const model = models().find(model => `${model.provider}/${model.id}` === request.model);
      if (!model) throw new RequestError('Model is unavailable. Check Pi login and the selected model.', 404);
      const { context, custom, toolMap, options } = translate(request, model, codec);
      if (process.env.CODEX_PI_DEBUG) console.error(`[pi-codex] effort=${options.reasoning || 'none'} requested=${request.reasoning?.effort || 'absent'}`);
      const showReasoning = request.reasoning?.summary !== 'none';
      const response = { id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), model: request.model, status: 'in_progress', output: [], usage: null };
      const emit = (type, fields) => {
        if (!request.stream || res.destroyed) return;
        if (res.writableLength > 4 * 1024 * 1024) throw new Error('Client is not reading the event stream.');
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`);
      };
      if (request.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        emit('response.created', { response });
        heartbeat = setInterval(() => {
          try { emit('response.in_progress', { response: { ...response, output: [] } }); }
          catch (error) { controller.abort(error); }
        }, 15000);
      }
      const blocks = new Map();
      const start = (index, block) => {
        if (blocks.has(index)) return blocks.get(index);
        const state = { id: `${block.type === 'thinking' ? 'rs' : block.type === 'text' ? 'msg' : 'fc'}_${randomUUID()}`, output_index: blocks.size, ended: false, customInput: '' };
        blocks.set(index, state);
        emit('response.output_item.added', { output_index: state.output_index, item: outputItem(block, state.id, custom, toolMap, codec, request.model, false, showReasoning) });
        if (block.type === 'text') emit('response.content_part.added', { item_id: state.id, output_index: state.output_index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        if (block.type === 'thinking' && showReasoning) emit('response.reasoning_summary_part.added', { item_id: state.id, output_index: state.output_index, summary_index: 0, part: { type: 'summary_text', text: '' } });
        return state;
      };
      const customDelta = (state, input) => {
        if (typeof input !== 'string') return;
        // A partial JSON parser can expose a trailing, incomplete UTF-16 pair.
        if (/[\uD800-\uDBFF]$/.test(input)) input = input.slice(0, -1);
        if (!input.startsWith(state.customInput)) throw new Error('Provider changed an already streamed tool input.');
        const delta = input.slice(state.customInput.length);
        if (delta) emit('response.custom_tool_call_input.delta', { item_id: state.id, output_index: state.output_index, delta });
        state.customInput = input;
      };
      const finish = (index, block) => {
        const state = start(index, block);
        if (state.ended) return;
        state.ended = true;
        const item = outputItem(block, state.id, custom, toolMap, codec, request.model, true, showReasoning);
        const fields = { item_id: state.id, output_index: state.output_index };
        if (block.type === 'text') {
          emit('response.output_text.done', { ...fields, content_index: 0, text: block.text });
          emit('response.content_part.done', { ...fields, content_index: 0, part: item.content[0] });
        } else if (block.type === 'thinking') {
          if (showReasoning) {
            emit('response.reasoning_summary_text.done', { ...fields, summary_index: 0, text: block.thinking || '' });
            emit('response.reasoning_summary_part.done', { ...fields, summary_index: 0, part: { type: 'summary_text', text: block.thinking || '' } });
          }
        } else if (custom.has(block.name)) {
          customDelta(state, item.input);
          emit('response.custom_tool_call_input.done', { ...fields, input: item.input });
        } else emit('response.function_call_arguments.done', { ...fields, arguments: item.arguments });
        response.output[state.output_index] = item;
        emit('response.output_item.done', { output_index: state.output_index, item });
      };
      let complete = false;
      for await (const event of registry.streamSimple(model, context, { ...options, signal: controller.signal })) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (event.type === 'error') throw new Error(event.error.errorMessage || 'Provider request failed.');
        if (event.type === 'done') {
          if (process.env.CODEX_PI_DEBUG) console.error(`[pi-codex] done reason=${event.reason} output_tokens=${event.message.usage.output}`);
          event.message.content.forEach((block, index) => finish(index, block));
          response.usage = usage(event.message.usage);
          response.status = event.reason === 'length' ? 'incomplete' : 'completed';
          if (event.reason === 'length') response.incomplete_details = { reason: 'max_output_tokens' };
          emit(event.reason === 'length' ? 'response.incomplete' : 'response.completed', { response });
          complete = true;
          break;
        }
        if (event.contentIndex === undefined) continue;
        const block = event.partial.content[event.contentIndex];
        if (!block) throw new Error('Provider event has no content block.');
        const state = start(event.contentIndex, block);
        const fields = { item_id: state.id, output_index: state.output_index };
        if (event.type === 'text_delta') emit('response.output_text.delta', { ...fields, content_index: 0, delta: event.delta });
        if (event.type === 'thinking_delta' && showReasoning) emit('response.reasoning_summary_text.delta', { ...fields, summary_index: 0, delta: event.delta });
        if (event.type === 'toolcall_delta' && !custom.has(block.name)) emit('response.function_call_arguments.delta', { ...fields, delta: event.delta });
        if (event.type === 'toolcall_delta' && custom.has(block.name)) customDelta(state, block.arguments?.input);
        if (event.type.endsWith('_end')) finish(event.contentIndex, block);
      }
      if (!complete) throw new Error('Provider stream ended without a completion event.');
      if (request.stream) res.end(); else json(res, 200, response);
    } catch (error) {
      console.error(`[pi-codex] request failed: ${error.message}`);
      if (!res.destroyed) {
        const code = /context.*(exceed|long)|prompt is too long/i.test(error.message) ? 'context_length_exceeded'
          : /429|rate.limit/i.test(error.message) ? 'rate_limit_exceeded'
          : /400|invalid_request|unsupported|undeclared tool/i.test(error.message) ? 'invalid_prompt' : 'server_error';
        if (res.headersSent) res.end(`event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', sequence_number: sequence++, response: { id: responseId, status: 'failed', error: { code, message: error.message } } })}\n\n`);
        else json(res, error.status || 502, { error: { message: error.message } });
      }
    } finally {
      clearTimeout(timer); clearInterval(heartbeat); controller.abort(); controllers.delete(controller);
    }
  });
  return { server, close() { for (const controller of controllers) controller.abort(); server.closeAllConnections(); server.close(); } };
}
