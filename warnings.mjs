import { appendFileSync, readFileSync } from 'node:fs';

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
