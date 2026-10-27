import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxTailBytes = 8 * 1024 * 1024;

// Use Codex's operation metadata, never model-visible text, to identify this path.
export function previousModelCompaction(request, headers) {
  try {
    const metadata = JSON.parse(request.client_metadata?.['x-codex-turn-metadata'] ?? headers['x-codex-turn-metadata']);
    const compact = metadata.compaction;
    if (metadata.request_kind !== 'compaction' || compact?.trigger !== 'auto' || compact.phase !== 'pre_turn'
      || !['model_downshift', 'comp_hash_changed'].includes(compact.reason)
      || !uuid.test(metadata.thread_id) || !uuid.test(metadata.turn_id)) return;
    return { threadId: metadata.thread_id, turnId: metadata.turn_id };
  } catch { return; }
}

// A model switch is persisted before task_started, whereas turn_context is written
// only after pre-turn compaction succeeds. Never use the last turn_context here.
export function selectedModelForTurn(rows, { threadId, turnId }) {
  let settings;
  let selected;
  let found = false;
  for (const row of rows) {
    if (row.type !== 'event_msg') continue;
    const event = row.payload;
    if (event?.type === 'thread_settings_applied' && event.thread_id === threadId) settings = event.thread_settings;
    if (event?.type === 'task_started') {
      if (found) return; // A later turn superseded the request.
      if (event.turn_id === turnId) {
        found = true;
        selected = settings;
      }
    }
    if (found && ['task_complete', 'turn_aborted'].includes(event?.type) && event.turn_id === turnId) return;
  }
  if (found && selected?.model_provider_id === 'pi_claude' && typeof selected.model === 'string') {
    return { model: selected.model, reasoningEffort: selected.reasoning_effort };
  }
}

// Read-only, bounded lookup, performed only after a rate limit. Older Codex versions
// or unavailable/incomplete records leave the original provider error untouched.
export function createSelectedModelReader(codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')) {
  return async identity => {
    if (!uuid.test(identity.threadId) || !uuid.test(identity.turnId)) return;
    try {
      const entries = await readdir(join(codexHome, 'sessions'), { recursive: true, withFileTypes: true });
      const matches = entries.filter(entry => entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${identity.threadId}.jsonl`));
      if (matches.length !== 1) return;
      const entry = matches[0];
      const file = await open(join(entry.parentPath, entry.name), 'r');
      try {
        const { size } = await file.stat();
        const start = Math.max(0, size - maxTailBytes);
        const buffer = Buffer.alloc(size - start);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
        let lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
        if (start) lines.shift();
        // Do not infer a selection from a partially flushed record.
        if (lines.pop() !== '') return;
        return selectedModelForTurn(lines.filter(Boolean).map(line => JSON.parse(line)), identity);
      } finally { await file.close(); }
    } catch { return; }
  };
}
