import { createHash } from 'node:crypto';

const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const extensions = (value, semanticKeys) => value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => !semanticKeys.includes(key)).map(([key, field]) => [key, clone(field)])) : {};
const identities = new WeakMap();
const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

function history(format, value) {
  const result = { version: 1, scope: 'request', source: { format, value: clone(value) }, entries: [] };
  identities.set(result, new Map());
  return result;
}

function append(target, entry, path, original) {
  const identity = original?.id || original?.uuid || fingerprint(original);
  const base = `${target.source.format}:${entry.kind}:${identity}`;
  const seen = identities.get(target);
  const occurrence = seen.get(base) || 0;
  seen.set(base, occurrence + 1);
  target.entries.push({ id: occurrence ? `${base}:${occurrence}` : base, origin: path, ...entry });
}

function content(value, format) {
  if (typeof value === 'string') return [{ kind: 'text', text: value }];
  if (!Array.isArray(value)) return [{ kind: 'opaque', format, value: clone(value) }];
  return value.map(part => {
    const native = { format, value: clone(part) };
    if (['text', 'input_text', 'output_text'].includes(part.type)) return { kind: 'text', text: part.text, native };
    if (part.type === 'input_image') return { kind: 'image', url: part.image_url, detail: part.detail, native };
    if (part.type === 'image' && part.source?.type === 'base64') return { kind: 'image', url: `data:${part.source.media_type};base64,${part.source.data}` };
    if (part.type === 'image' && part.source?.type === 'url') return { kind: 'image', url: part.source.url };
    return { kind: 'opaque', format, value: clone(part) };
  });
}

export function fromResponses(input, { codec } = {}) {
  const result = history('responses', input);
  const items = typeof input === 'string' ? [{ type: 'message', role: 'user', content: input }] : input;
  if (!Array.isArray(items)) throw new Error('Responses history must be text or an array.');
  for (const [index, item] of items.entries()) {
    const path = typeof input === 'string' ? [] : [index];
    let entry;
    if (item.type === 'message' || (!item.type && item.role)) {
      entry = { kind: 'message', role: item.role, content: content(item.content, 'responses') };
    } else if (item.type === 'additional_tools') {
      if (!Array.isArray(item.tools)) throw new Error('Additional tools must be an array.');
      entry = { kind: 'tool_definitions', role: item.role, tools: clone(item.tools) };
    } else if (item.type === 'reasoning') {
      const bridge = item.encrypted_content?.startsWith('pi1.');
      const decoded = bridge && codec ? codec.open(item.encrypted_content) : null;
      entry = { kind: 'reasoning', summaries: (item.summary || []).map(part => clone(part)),
        state: { provider: bridge ? 'anthropic' : 'openai', model: decoded?.model ?? null,
          encoding: bridge ? 'bridge-pi1' : 'openai-responses', value: item.encrypted_content ?? null } };
    } else if (['function_call', 'custom_tool_call'].includes(item.type)) {
      entry = { kind: 'tool_call', callId: item.call_id, name: item.name, namespace: item.namespace ?? null,
        arguments: { encoding: item.type === 'custom_tool_call' ? 'text' : 'json', value: item.type === 'custom_tool_call' ? item.input : item.arguments || '{}' } };
    } else if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) {
      entry = { kind: 'tool_result', callId: item.call_id, toolKind: item.type === 'custom_tool_call_output' ? 'custom' : 'function', content: content(item.output, 'responses'), isError: false };
    } else {
      entry = { kind: 'artifact', artifactType: item.type, provider: 'openai' };
    }
    append(result, entry, path, item);
  }
  return result;
}

export function fromAnthropic(messages, { model = null } = {}) {
  if (!Array.isArray(messages)) throw new Error('Anthropic history must be an array.');
  const result = history('anthropic-messages', messages);
  for (const [index, message] of messages.entries()) {
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    if (!Array.isArray(blocks)) throw new Error('Anthropic message content must be text or an array.');
    for (const [blockIndex, block] of blocks.entries()) {
      const path = typeof message.content === 'string' ? [index] : [index, 'content', blockIndex];
      let entry;
      if (['thinking', 'redacted_thinking'].includes(block.type)) {
        entry = { kind: 'reasoning', summaries: block.type === 'thinking' ? [{ type: 'summary_text', text: block.thinking }] : [],
          state: { provider: 'anthropic', model: message.model || model, encoding: 'anthropic-block', value: clone(block) } };
      } else if (block.type === 'tool_use') {
        entry = { kind: 'tool_call', callId: block.id, name: block.name, namespace: null, arguments: { encoding: 'json', value: JSON.stringify(block.input) } };
      } else if (block.type === 'tool_result') {
        entry = { kind: 'tool_result', callId: block.tool_use_id, toolKind: 'function', content: content(block.content ?? '', 'anthropic-messages'), isError: Boolean(block.is_error) };
      } else {
        entry = { kind: 'message', role: message.role, content: content([block], 'anthropic-messages') };
      }
      const messageId = message.id || `${index}`;
      const previous = result.entries.at(-1);
      if (entry.kind === 'message' && previous?.kind === 'message' && previous.messageId === messageId) previous.content.push(...entry.content);
      else append(result, { ...entry, messageId }, path, block);
    }
  }
  return result;
}

export function restoreSource(canonical) {
  if (canonical.version !== 1) throw new Error('Unsupported canonical history version.');
  return clone(canonical.source.value);
}

function original(canonical, entry) {
  return entry.origin.reduce((value, key) => value[key], canonical.source.value);
}

function assertRequest(canonical) {
  if (canonical.version !== 1 || canonical.scope !== 'request') throw new Error('Select an active request history before projecting an archive.');
}

function responseContent(parts, role) {
  return parts.map(part => {
    const native = part.native?.format === 'responses' ? part.native.value : null;
    const compatible = part.kind === 'text' ? ['input_text', 'output_text', 'text'].includes(native?.type) && native.text === part.text
      : part.kind === 'image' && native?.type === 'input_image' && native.image_url === part.url;
    const fields = compatible ? extensions(native, ['type', 'text', 'image_url', 'detail', 'source']) : {};
    if (part.kind === 'text') return { ...fields, type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text };
    if (part.kind === 'image') return { ...fields, type: 'input_image', image_url: part.url, ...(part.detail ? { detail: part.detail } : {}) };
    if (part.format === 'responses') return clone(part.value);
    throw new Error(`Cannot project ${part.value?.type || part.kind} content to OpenAI without losing information.`);
  });
}

export function toOpenAI(canonical) {
  assertRequest(canonical);
  return canonical.entries.flatMap(entry => {
    const native = canonical.source.format === 'responses' ? original(canonical, entry) : null;
    if (entry.kind === 'tool_definitions') return [{ ...extensions(native, ['type', 'role', 'tools']),
      type: 'additional_tools', role: entry.role, tools: clone(entry.tools) }];
    if (entry.kind === 'reasoning') {
      if (entry.state.provider === 'openai') {
        if (entry.state.encoding !== 'openai-responses') throw new Error('OpenAI reasoning has an incompatible state encoding.');
        return [{ ...extensions(native, ['type', 'summary', 'encrypted_content']), type: 'reasoning', summary: clone(entry.summaries), ...(entry.state.value ? { encrypted_content: entry.state.value } : {}) }];
      }
      const text = entry.summaries.filter(part => part.type === 'summary_text').map(part => part.text).join('\n');
      return text ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Historical reasoning summary:\n${text}` }] }] : [];
    }
    if (entry.kind === 'message') return [{ ...extensions(native, ['type', 'role', 'content']), type: 'message', role: entry.role,
      content: responseContent(entry.content, entry.role) }];
    if (entry.kind === 'tool_call') {
      const custom = entry.arguments.encoding === 'text';
      const value = { ...extensions(native, ['type', 'call_id', 'name', 'namespace', 'input', 'arguments']), type: custom ? 'custom_tool_call' : 'function_call', call_id: entry.callId, name: entry.name,
        ...(entry.namespace ? { namespace: entry.namespace } : {}), ...(custom ? { input: entry.arguments.value } : { arguments: entry.arguments.value }) };
      const prefix = custom ? 'ctc_' : 'fc_';
      if (value.id && !value.id.startsWith(prefix)) value.id = prefix + (/^(?:fc|ctc|msg|rs)_/.test(value.id) ? value.id.slice(value.id.indexOf('_') + 1) : fingerprint(entry.id).slice(0, 32));
      return [value];
    }
    if (entry.kind === 'tool_result') {
      const output = typeof native?.output === 'string' && entry.content.every(part => part.kind === 'text')
        ? entry.content.map(part => part.text).join('') : responseContent(entry.content, 'user');
      return [{ ...extensions(native, ['type', 'call_id', 'output']), type: entry.toolKind === 'custom' ? 'custom_tool_call_output' : 'function_call_output', call_id: entry.callId,
        output: entry.isError ? [{ type: 'input_text', text: 'This tool execution failed.' }, ...responseContent(entry.content, 'user')] : output }];
    }
    if (entry.kind === 'artifact' && native) return [clone(native)];
    throw new Error(`Unsupported canonical entry for OpenAI: ${entry.kind}`);
  });
}

function piContent(parts) {
  return parts.map(part => {
    if (part.kind === 'text') return { type: 'text', text: part.text };
    if (part.kind === 'image') {
      const match = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(part.url || '');
      if (!match) throw new Error('Images must use base64 data URLs. Remote image URLs and file IDs are not supported.');
      return { type: 'image', mimeType: match[1], data: match[2] };
    }
    throw new Error(`Unsupported message content: ${part.value?.type || part.kind}`);
  });
}

export function toAnthropic(canonical, model, { codec, toolName = name => name } = {}) {
  assertRequest(canonical);
  const messages = [];
  const toolNames = new Map();
  const toolOwners = new Map();
  const resultsByOwner = new Map();
  const answeredCalls = new Set();
  const assistant = () => {
    if (messages.at(-1)?.role !== 'assistant') messages.push({ role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage: emptyUsage(), stopReason: 'stop', timestamp: Date.now() });
    return messages.at(-1);
  };
  for (const entry of canonical.entries) {
    if (entry.kind === 'tool_definitions') continue;
    if (entry.kind === 'reasoning') {
      const state = entry.state;
      if (state.provider === 'anthropic') {
        if (!['bridge-pi1', 'anthropic-block'].includes(state.encoding)) throw new Error('Claude reasoning has an incompatible state encoding.');
        const restored = state.encoding === 'bridge-pi1' ? codec?.open(state.value)
          : { model: state.model, block: state.value.type === 'redacted_thinking'
            ? { type: 'thinking', thinking: '', thinkingSignature: state.value.data, redacted: true }
            : { type: 'thinking', thinking: state.value.thinking, thinkingSignature: state.value.signature } };
        if (!restored) throw new Error('Claude reasoning requires the original bridge key.');
        if (state.model && state.model !== restored.model) throw new Error('Claude reasoning model does not match its signed state.');
        const message = assistant();
        const sourceModel = restored.model?.replace(/^anthropic\//, '');
        message.provider = 'anthropic';
        message.model = sourceModel || 'unknown-source-model';
        message.content.push(clone(restored.block));
      } else {
        const summary = entry.summaries.filter(part => part.type === 'summary_text').map(part => part.text).join('\n');
        if (summary) assistant().content.push({ type: 'text', text: `Historical reasoning summary:\n${summary}` });
      }
    } else if (entry.kind === 'tool_call') {
      let args;
      try { args = entry.arguments.encoding === 'text' ? { input: entry.arguments.value } : JSON.parse(entry.arguments.value); }
      catch { throw new Error(`Invalid arguments for ${entry.name}`); }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object.');
      const name = toolName(entry.name, entry.namespace);
      if (toolOwners.has(entry.callId)) throw new Error(`Duplicate tool call ID: ${entry.callId}`);
      toolNames.set(entry.callId, name);
      toolOwners.set(entry.callId, assistant());
      assistant().content.push({ type: 'toolCall', id: entry.callId, name, arguments: args });
      assistant().stopReason = 'toolUse';
    } else if (entry.kind === 'tool_result') {
      const name = toolNames.get(entry.callId);
      if (!name) throw new Error(`No preceding tool call for ${entry.callId}`);
      if (answeredCalls.has(entry.callId)) throw new Error(`Duplicate tool result for ${entry.callId}`);
      answeredCalls.add(entry.callId);
      const result = { role: 'toolResult', toolCallId: entry.callId, toolName: name, content: piContent(entry.content), isError: entry.isError, timestamp: Date.now() };
      const owner = toolOwners.get(entry.callId);
      if (!resultsByOwner.has(owner)) resultsByOwner.set(owner, []);
      resultsByOwner.get(owner).push(result);
      messages.push(result);
    } else if (entry.kind === 'message') {
      const body = piContent(entry.content);
      if (entry.role === 'assistant') {
        if (body.some(part => part.type !== 'text')) throw new Error('Assistant images are not supported.');
        assistant().content.push(...body);
      } else if (['system', 'developer'].includes(entry.role)) {
        if (body.some(part => part.type !== 'text')) throw new Error('System messages must be text.');
        messages.push({ role: 'system', content: body, timestamp: Date.now() });
      } else if (entry.role === 'user') messages.push({ role: 'user', content: body, timestamp: Date.now() });
      else throw new Error(`Unsupported message role: ${entry.role}`);
    } else throw new Error(`Unsupported input item: ${entry.artifactType || entry.kind}`);
  }
  // Codex can save user steering or later assistant messages before an in-flight
  // tool returns. Claude requires results directly after the calling assistant.
  // Group results only in this projection, preserving their arrival order and
  // all other messages. Otherwise Pi inserts a synthetic result before the user
  // message and sends the real result later as an unmatched duplicate.
  return messages.flatMap(message => message.role === 'toolResult' ? [] : [message, ...(resultsByOwner.get(message) || [])]);
}

export function fromTranscript(format, text, options = {}) {
  if (!['codex-jsonl', 'claude-code-jsonl'].includes(format)) throw new Error(`Unsupported transcript format: ${format}`);
  const result = { version: 1, scope: 'archive', source: { format, value: text }, records: [] };
  for (const [line, value] of text.split('\n').entries()) {
    if (!value.trim()) continue;
    const record = JSON.parse(value);
    let conversation = null;
    if (format === 'codex-jsonl' && record.type === 'response_item') conversation = fromResponses([record.payload], options);
    if (format === 'claude-code-jsonl' && ['user', 'assistant'].includes(record.type) && record.message) conversation = fromAnthropic([record.message], options);
    result.records.push({ line, type: record.type, id: record.uuid || record.payload?.id || null, parentId: record.parentUuid || null, metadata: clone(record), conversation });
  }
  return result;
}
