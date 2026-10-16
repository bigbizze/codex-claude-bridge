import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual, createHash } from 'node:crypto';
import { forwardOpenAI } from './routing.mjs';
import { mergeCatalogs } from './model-catalog.mjs';
import { fromResponses, toAnthropic } from './history.mjs';

export class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const instructions = readFileSync(new URL('./codex-instructions.md', import.meta.url), 'utf8');
const wireName = (name, namespace) => 'tool_' + createHash('sha256').update(JSON.stringify([namespace || null, name])).digest('hex').slice(0, 32);

function toolInstructions(toolMap, toolChoice, hasPlanner) {
  const lines = [
    '## Current bridge tool bindings',
    'Only the tools declared on this request are callable. Earlier instructions, examples, plans, and historical calls do not make other tools available.',
    'Codex tool references are mapped to the exact provider tool names below. Use those declared names verbatim; never invent aliases or placeholder tools.',
  ];
  if (toolChoice === 'none' || toolMap.size === 0) {
    lines.push('No tool calls are permitted on this request. Respond with text instead.');
  } else {
    for (const [name, original] of toolMap) lines.push(JSON.stringify({ codex_tool: original, provider_tool: name }));
  }
  if (toolChoice === 'none' || !hasPlanner) {
    lines.push('The Codex update_plan tool is not available on this request. When a plan is useful, describe it briefly in text. Do not invent substitute tools or use unrelated tools with similar names to satisfy a planning instruction.');
  }
  return lines.join('\n');
}

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
    supported_reasoning_levels: model.reasoning ? ['low', 'medium', 'high', 'xhigh', 'max'].filter(level =>
      ['xhigh', 'max'].includes(level) ? model.thinkingLevelMap?.[level] === level : model.thinkingLevelMap?.[level] !== null
    ).map(effort => ({ effort, description: `${effort} reasoning effort` })) : [],
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

export function translate(request, model, codec) {
  if (request.previous_response_id) throw new RequestError('Send full input history; previous_response_id is not supported.');
  if (request.background) throw new RequestError('Background Responses jobs are not supported.');
  const custom = new Set();
  const toolMap = new Map();
  const flatTools = (request.tools || []).flatMap(tool => tool.type === 'namespace'
    ? tool.tools.map(inner => ({ ...inner, namespace: tool.name })) : [tool]);
  const hasPlanner = flatTools.some(tool => {
    const plan = tool.parameters?.properties?.plan;
    return tool.type === 'function' && tool.name === 'update_plan' && (!tool.namespace || tool.namespace === 'functions') &&
      plan?.type === 'array' && plan.items?.properties?.step?.type === 'string' &&
      ['pending', 'in_progress', 'completed'].every(status => plan.items?.properties?.status?.enum?.includes(status));
  });
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
  let messages;
  try { messages = toAnthropic(fromResponses(request.input ?? []), model, { codec, toolName: wireName }); }
  catch (error) { throw new RequestError(error.message); }
  const effort = request.reasoning?.effort ?? 'medium';
  if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new RequestError(`Unsupported reasoning effort: ${effort}`);
  // Codex persists completed items in event arrival order. Keep signed thinking first
  // even when replaying a conversation created by the earlier bridge.
  for (const message of messages) if (message.role === 'assistant') message.content.sort((a, b) => Number(b.type === 'thinking') - Number(a.type === 'thinking'));
  // A failed stream can leave a completed reasoning item without its text or tool
  // call. Anthropic rejects thinking-only assistant turns even before a user
  // continuation. Omit these unfinished turns from replay; retain the source log.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'assistant' && !message.content.some(block =>
      block.type === 'toolCall' || (block.type === 'text' && block.text.trim()))) messages.splice(index, 1);
  }
  // Codex can retry after retaining completed items from an interrupted response.
  // Responses history ending in assistant text is not an Anthropic prefill request.
  // Keep that history and explicitly request continuation. Pi closes orphaned tool
  // calls with tool results, so those already supply the required user boundary.
  const lastConversationMessage = messages.findLast(message => message.role !== 'system');
  if (lastConversationMessage?.role === 'assistant' && !lastConversationMessage.content.some(block => block.type === 'toolCall')) {
    messages.push({ role: 'user', content: [{ type: 'text', text: 'Continue from the previous assistant response. Follow the existing instructions and complete the pending request.' }], timestamp: Date.now() });
  }
  const systemPrompt = [request.instructions || '', toolInstructions(toolMap, request.tool_choice, hasPlanner)].filter(Boolean).join('\n\n');
  return { context: { systemPrompt, messages, tools }, custom, toolMap,
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

export function createBridge({ registry, token, codec, requestTimeoutMs = 600000, openai }) {
  const expected = Buffer.from(token);
  const controllers = new Set();
  const server = http.createServer(async (req, res) => {
    const auth = Buffer.from(req.headers['x-codex-bridge-token'] || (req.headers.authorization || '').replace(/^Bearer /, ''));
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return json(res, 401, { error: { message: 'Bridge authentication required.' } });
    const path = new URL(req.url, 'http://localhost').pathname;
    const models = () => registry.getAvailable().filter(model => model.provider === 'anthropic');
    if (req.method === 'GET' && path === '/health') return json(res, 200, { service: 'codex-claude-bridge', version: 2 });
    if (req.method === 'GET' && path === '/v1/models') return json(res, 200, mergeCatalogs(catalog(models()), openai?.catalog || { models: [] }));
    if (req.method !== 'POST' || path !== '/v1/responses') return json(res, 404, { error: { message: 'Unsupported endpoint.' } });
    const controller = new AbortController();
    controllers.add(controller);
    // Bound inactivity, not total generation time. Long tool inputs and thinking
    // can stream for more than ten minutes. Local SSE heartbeats do not count.
    let timer;
    const resetIdleTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error('Provider idle timeout: no model activity for ' + requestTimeoutMs / 1000 + ' seconds.')), requestTimeoutMs);
    };
    resetIdleTimeout();
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
      if (openai?.catalog.models.some(entry => entry.slug === request.model?.replace(/^openai\//, ''))) {
        if (!req.headers['x-codex-bridge-token'] || req.headers.authorization === `Bearer ${token}`) throw new RequestError('OpenAI requests require Codex authentication and the bridge token.', 401);
        await forwardOpenAI({ request, headers: req.headers, response: res, signal: controller.signal, onActivity: resetIdleTimeout, ...openai });
        return;
      }
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
        const prefix = block.type === 'thinking' ? 'rs' : block.type === 'text' ? 'msg' : custom.has(block.name) ? 'ctc' : 'fc';
        const state = { id: `${prefix}_${randomUUID()}`, output_index: blocks.size, ended: false, customInput: '' };
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
      // Pi defaults to no retries. Use its provider retry policy, which honors
      // Retry-After and cancellation and only retries before response streaming.
      for await (const event of registry.streamSimple(model, context, { ...options, maxRetries: 2, signal: controller.signal })) {
        if (controller.signal.aborted) throw controller.signal.reason;
        resetIdleTimeout();
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
