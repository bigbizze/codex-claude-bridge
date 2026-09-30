import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// This client never makes a turn/start request or handles model credentials.
export class AppServer {
  constructor(args = [], { env = process.env, cwd = process.cwd(), timeoutMs = 30000, command = 'codex' } = {}) {
    this.pending = new Map();
    this.nextId = 0;
    this.timeoutMs = timeoutMs;
    this.process = spawn(command, [...args, 'app-server', '--stdio'], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.lines = createInterface({ input: this.process.stdout });
    this.process.stderr.resume();
    this.exited = new Promise(resolve => {
      this.process.once('error', error => { this.fail(error); resolve(); });
      this.process.once('exit', () => { this.fail(new Error('Codex App Server exited.')); resolve(); });
    });
    this.process.stdin.on('error', error => this.fail(error));
    this.lines.on('line', line => {
      try {
        const message = JSON.parse(line);
        if (message.method) {
          if (message.id !== undefined) this.send({ id: message.id, error: { code: -32601, message: 'Handoff client does not execute tools or authorize actions.' } });
          return;
        }
        const entry = this.pending.get(message.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
        else entry.resolve(message.result);
      } catch { this.fail(new Error('Invalid JSON from Codex App Server.')); }
    });
  }

  fail(error) {
    this.failure = error;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }

  send(message) { this.process.stdin.write(JSON.stringify(message) + '\n'); }

  call(method, params = {}) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out; no continuation will be launched.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.send({ id, method, params });
    });
  }

  async initialize() {
    await this.call('initialize', { clientInfo: { name: 'codex_claude_handoff', version: '1' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
  }

  async close() {
    if (!this.closing) this.closing = (async () => {
      this.process.stdin.end();
      const timer = setTimeout(() => this.process.kill('SIGTERM'), 1000);
      const killTimer = setTimeout(() => this.process.kill('SIGKILL'), 3000);
      await this.exited;
      clearTimeout(timer);
      clearTimeout(killTimer);
      this.lines.close();
    })();
    return this.closing;
  }
}
