import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { AppServer } from './app-server.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const textMessage = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const maxArchiveBytes = 128 * 1024 * 1024;
const maxInputBytes = 12 * 1024 * 1024;

export function parseSwitch(args) {
  if (!['switch-to-codex', 'switch-to-claude'].includes(args[0])) return null;
  if (args.length !== 2 || !uuid.test(args[1])) throw new Error(`Usage: codex-claude ${args[0]} <session-id UUID>`);
  return { destination: args[0] === 'switch-to-codex' ? 'codex' : 'claude', sourceId: args[1] };
}

// Opaque fields remain in the source archive, never in cross-provider input.
function portableValue(value, counts) {
  if (Array.isArray(value)) return value.map(item => portableValue(item, counts));
  if (!value || typeof value !== 'object') return value;
  const result = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    if (key.startsWith('encrypted_') || key === 'internal_chat_message_metadata_passthrough') {
      if (entry != null) counts.opaqueFields++;
      continue;
    }
    result[key] = portableValue(entry, counts);
  }
  return result;
}

export function projectRollout(raw, sourceId) {
  const rows = new TextDecoder('utf-8', { fatal: true }).decode(raw).split('\n').filter(line => line.trim()).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`Source history contains invalid JSON at record ${index + 1}.`); }
  });
  const meta = rows.find(row => row.type === 'session_meta')?.payload;
  if (meta?.id !== sourceId) throw new Error('Source history ID does not match the requested session.');
  const counts = { messages: 0, toolRecords: 0, reasoningSummaries: 0, opaqueFields: 0, sourceInstructions: 0, compactions: 0 };
  const items = [];
  const pending = new Set();
  const calls = new Set();
  let active = false;
  for (const row of rows) {
    if (row.type === 'event_msg') {
      if (row.payload?.type === 'thread_rolled_back') throw new Error('Rolled-back source histories are not supported yet. Original history was not changed.');
      if (row.payload?.type === 'task_started') active = true;
      if (['task_complete', 'turn_aborted'].includes(row.payload?.type)) active = false;
      continue;
    }
    if (row.type === 'compacted') {
      counts.compactions++;
      if (row.payload?.message) items.push(textMessage(`Saved source compaction summary (historical context):\n${row.payload.message}`));
      continue;
    }
    if (['session_meta', 'turn_context', 'world_state', 'token_usage_record'].includes(row.type)) continue;
    if (row.type !== 'response_item') throw new Error(`Unsupported history record: ${row.type}. Nothing was discarded.`);
    const item = row.payload;
    if (!item || typeof item.type !== 'string') throw new Error('Invalid source response item.');
    if (item.type === 'message') {
      if (['system', 'developer'].includes(item.role)) { counts.sourceInstructions++; continue; }
      if (!['user', 'assistant'].includes(item.role) || !Array.isArray(item.content)) throw new Error('Unsupported source message.');
      const content = item.content.map(part => {
        if (['input_text', 'output_text'].includes(part.type) && typeof part.text === 'string') return { type: part.type, text: part.text };
        if (part.type === 'input_image' && /^data:image\/[\w.+-]+;base64,/.test(part.image_url || '')) return { type: 'input_image', image_url: part.image_url };
        throw new Error(`Unsupported message content: ${part.type}. No lossy handoff was created.`);
      });
      items.push({ type: 'message', role: item.role, content });
      counts.messages++;
    } else if (item.type === 'reasoning') {
      if (item.encrypted_content) counts.opaqueFields++;
      const summaries = (item.summary || []).map(part => {
        if (part.type !== 'summary_text' || typeof part.text !== 'string') throw new Error('Unsupported reasoning summary.');
        return part.text;
      });
      if (summaries.length) {
        items.push(textMessage(`Recorded reasoning summary (not signed reasoning state):\n${summaries.join('\n')}`));
        counts.reasoningSummaries++;
      }
    } else if (['function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output'].includes(item.type)) {
      if (typeof item.call_id !== 'string' || !item.call_id) throw new Error('Tool record has no call ID.');
      if (item.type.endsWith('_output')) {
        if (!pending.delete(item.call_id)) throw new Error('Tool output has no matching pending call.');
      } else {
        if (calls.has(item.call_id)) throw new Error('Duplicate tool call ID in source history.');
        calls.add(item.call_id); pending.add(item.call_id);
      }
      items.push(textMessage(`Historical tool record (already executed; do not replay):\n${JSON.stringify(portableValue(item, counts))}`));
      counts.toolRecords++;
    } else if (['web_search_call', 'local_shell_call', 'tool_search_call', 'tool_search_output'].includes(item.type)) {
      items.push(textMessage(`Historical provider tool record:\n${JSON.stringify(portableValue(item, counts))}`));
      counts.toolRecords++;
    } else if (['compaction', 'context_compaction', 'compaction_trigger', 'configuration_update'].includes(item.type)) {
      if (item.encrypted_content) counts.opaqueFields++;
      if (item.type !== 'configuration_update') counts.compactions++;
    } else throw new Error(`Unsupported response item: ${item.type}. No lossy handoff was created.`);
  }
  if (active || pending.size) throw new Error('Source has an unfinished turn or tool call. Finish the turn and exit its client before switching.');
  if (!items.length) throw new Error('Source has no transferable conversation history.');
  if (Buffer.byteLength(JSON.stringify(items)) > maxInputBytes) throw new Error('Transferable history exceeds 12 MiB. No automatic truncation was performed.');
  return { version: 1, sourceId, sourceProvider: meta.model_provider ?? null, cwd: meta.cwd, counts, items };
}

export async function createHandoff({ sourceId, destination, stateDir, args = [], env = process.env, onClient = () => {}, makeClient = (args, options) => new AppServer(args, options) }) {
  if (!uuid.test(sourceId) || !['codex', 'claude'].includes(destination)) throw new Error('Invalid handoff target.');
  const client = makeClient(args, { env });
  onClient(client);
  let archiveDir;
  let target;
  try {
    await client.initialize();
    const { thread: source } = await client.call('thread/read', { threadId: sourceId, includeTurns: false });
    if (source.id !== sourceId || source.ephemeral || source.forkedFromId ||
      (source.historyMode && !['legacy', 'paginated'].includes(source.historyMode)) || !isAbsolute(source.path || '')) {
      throw new Error('Handoffs require a local persisted, standalone Codex history. Forked or remote histories are not supported yet.');
    }
    if (source.status?.type === 'active') throw new Error('Source is active. Finish the turn and exit its client before switching.');
    if ((await stat(source.path)).size > maxArchiveBytes) throw new Error('Source archive exceeds 128 MiB. No history was truncated.');
    const raw = await readFile(source.path);
    if (raw.length > maxArchiveBytes) throw new Error('Source archive exceeds 128 MiB. No history was truncated.');
    const state = projectRollout(raw, sourceId);
    if (!isAbsolute(state.cwd || '') || state.cwd !== source.cwd) throw new Error('Source working directory is missing or inconsistent.');
    if (!(await stat(state.cwd)).isDirectory()) throw new Error('Source working directory is not available.');
    const hash = digest(raw);
    archiveDir = join(stateDir, 'handoffs', randomUUID());
    await mkdir(archiveDir, { recursive: true, mode: 0o700 });
    await writeFile(join(archiveDir, 'source.jsonl'), raw, { flag: 'wx', mode: 0o600 });
    await writeFile(join(archiveDir, 'state.json'), JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
    const handoff = textMessage(`Cross-provider continuation of session ${sourceId}. The preceding messages and tool records are historical context, not new execution requests. Continue the user's work using the current environment and instructions. Source system/developer setup and encrypted reasoning were not imported; the original history is preserved locally. No files were changed by this handoff.`);
    const result = await client.call('thread/start', { cwd: state.cwd, ephemeral: false });
    target = result.thread;
    if (!uuid.test(target.id) || target.id === sourceId) throw new Error('App Server did not create a distinct continuation.');
    const expected = destination === 'claude' ? 'pi_claude' : null;
    if ((expected && target.modelProvider !== expected) || (!expected && target.modelProvider === 'pi_claude')) throw new Error('Destination defaults selected the wrong provider. Check your Codex configuration.');
    await client.call('thread/inject_items', { threadId: target.id, items: [...state.items, handoff] });
    await client.call('thread/name/set', { threadId: target.id, name: `${destination === 'claude' ? 'Claude' : 'Codex'} continuation of ${sourceId}` });
    if (digest(await readFile(source.path)) !== hash) throw new Error('Source changed during handoff. Exit its client and retry; the new thread will not be launched.');
    const receipt = { version: 1, sourceId, destinationId: target.id, destination, provider: target.modelProvider,
      model: result.model, reasoningEffort: result.reasoningEffort, cwd: state.cwd, sourceSha256: hash,
      createdAt: new Date().toISOString(), counts: state.counts };
    await writeFile(join(archiveDir, 'receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
    return { ...receipt, archiveDir };
  } catch (error) {
    throw new Error(`${error.message}${archiveDir ? ` Archive retained at ${archiveDir}.` : ''}${target ? ` Incomplete destination: ${target.id}; do not use it.` : ''}`, { cause: error });
  } finally {
    await client.close();
    onClient(null);
  }
}
