import { appendFileSync, readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export function createDiagnostics({ debug = false, write = chunk => process.stderr.write(chunk) } = {}) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  return chunk => {
    if (debug) { write(chunk); return; }
    const lines = (pending + decoder.write(chunk)).split('\n');
    pending = lines.pop().slice(-4000);
    for (const line of lines) {
      if (/^\[pi-codex\] \S+ usage limit (?:reached;|wait ended;)/.test(line)) write(line + '\n');
    }
  };
}

// Warnings tell the user that the bridge needs an update, for example after a
// provider changes an undocumented endpoint. Codex owns the terminal while it
// runs, so the bridge writes them to a file and the launcher prints them on exit.
export function createWarnings(file, log = () => {}) {
  const seen = new Set();
  return message => {
    log(message);
    if (!file || seen.has(message)) return;
    seen.add(message);
    try { appendFileSync(file, message + '\n', { mode: 0o600 }); } catch {}
  };
}

export function readWarnings(file) {
  try { return [...new Set(readFileSync(file, 'utf8').split('\n').filter(Boolean))]; } catch { return []; }
}
