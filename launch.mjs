import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, chmodSync, mkdtempSync, rmSync, existsSync, linkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHandoff, parseSwitch } from './handoff.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const model = process.env.CODEX_CLAUDE_MODEL || 'anthropic/claude-opus-5-5';
const userArgs = process.argv.slice(2);
const children = [];
let runtimeDir;
let codex;
let closing;
let handoffClient;

function child(command, args, options) {
  const process = spawn(command, args, options);
  const result = new Promise((resolve, reject) => {
    process.once('error', reject);
    process.once('exit', (code, signal) => resolve(signal ? 128 + (signal === 'SIGINT' ? 2 : 15) : code ?? 1));
  });
  // Avoid unhandled rejections if startup fails before the caller awaits result.
  result.catch(() => {});
  const entry = { process, result };
  children.push(entry);
  return entry;
}

async function cleanup() {
  if (closing) return closing;
  closing = (async () => {
    if (handoffClient) await handoffClient.close();
    for (const entry of [...children].reverse()) {
      if (entry.process.exitCode !== null || entry.process.signalCode !== null) continue;
      entry.process.kill('SIGTERM');
      const timer = setTimeout(() => entry.process.kill('SIGKILL'), 2000);
      await entry.result.catch(() => {});
      clearTimeout(timer);
    }
    if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
  })();
  return closing;
}
process.on('SIGTERM', () => { cleanup().then(() => process.exit(143)); });
process.on('SIGINT', () => { if (!codex) cleanup().then(() => process.exit(130)); });

async function main() {
  const switching = parseSwitch(userArgs);
  const stateDir = join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'codex-claude-bridge');
  const handoff = async (args, env) => {
    const result = await createHandoff({ ...switching, stateDir, args, env, onClient: client => { handoffClient = client; } });
    console.log(`Created ${result.destination} continuation: ${result.destinationId}`);
    console.log(`Provider: ${result.provider}; model: ${result.model}; effort: ${result.reasoningEffort ?? 'default'}.`);
    console.log(`Original session preserved. Handoff archive: ${result.archiveDir}`);
    return ['--no-daemon', '-C', result.cwd, 'resume', result.destinationId];
  };
  if (switching?.destination === 'codex') {
    const resumeArgs = await handoff([], process.env);
    codex = child('codex', resumeArgs, { stdio: 'inherit' });
    return codex.result;
  }
  if (userArgs.length === 1 && ['--version', '-V', '--help', '-h'].includes(userArgs[0])) {
    if (['--help', '-h'].includes(userArgs[0])) console.log('Bridge commands:\n  codex-claude --check\n  codex-claude switch-to-codex <session-id>\n  codex-claude switch-to-claude <session-id>\nSwitch commands preserve the source and open a new continuation using destination defaults.\n');
    codex = child('codex', userArgs, { stdio: 'inherit' });
    return codex.result;
  }
  if (!model.startsWith('anthropic/')) throw new Error('CODEX_CLAUDE_MODEL must name an anthropic/ model.');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const keyFile = join(stateDir, 'reasoning.key');
  if (!existsSync(keyFile)) {
    const pendingKey = join(stateDir, `reasoning-${randomBytes(12).toString('hex')}.tmp`);
    try {
      writeFileSync(pendingKey, randomBytes(32), { flag: 'wx', mode: 0o600 });
      try { linkSync(pendingKey, keyFile); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally { rmSync(pendingKey, { force: true }); }
  }
  if (readFileSync(keyFile).length !== 32) throw new Error('The bridge reasoning key must contain 32 bytes.');
  chmodSync(keyFile, 0o600);
  runtimeDir = mkdtempSync(join(tmpdir(), 'codex-claude-'));
  const token = randomBytes(32).toString('hex');
  const readyFile = join(runtimeDir, 'ready.json');
  const env = { ...process.env, CODEX_PI_BRIDGE_TOKEN: token, CODEX_PI_STATE_KEY_FILE: keyFile, CODEX_PI_READY_FILE: readyFile };
  const pi = child('pi', ['--mode', 'rpc', '--no-session', '--no-extensions', '-e', join(here, 'extension.ts'),
    '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes', '--no-tools', '--model', model],
    { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = '';
  pi.process.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); if (process.env.CODEX_PI_DEBUG) process.stderr.write(chunk); });
  pi.process.stdout.resume();
  let ready;
  const deadline = Date.now() + 30000;
  while (!ready) {
    if (Date.now() > deadline) throw new Error(`Pi bridge startup timed out. ${errors}`);
    if (pi.process.exitCode !== null || pi.process.signalCode !== null) throw new Error(`Pi exited before bridge startup. ${errors}`);
    try { ready = JSON.parse(readFileSync(readyFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!ready) await Promise.race([new Promise(resolve => setTimeout(resolve, 100)), pi.result.then(() => { throw new Error(`Pi exited before bridge startup. ${errors}`); })]);
  }
  if (!ready.catalog.models.some(item => item.slug === model)) throw new Error(`${model} is unavailable. Run pi and /login anthropic.`);
  const catalogFile = join(runtimeDir, 'models.json');
  writeFileSync(catalogFile, JSON.stringify(ready.catalog), { mode: 0o600 });
  const config = [
    '-c', 'model_provider="pi_claude"',
    '-c', 'model_providers.pi_claude.name="Pi Claude"',
    '-c', `model_providers.pi_claude.base_url="http://127.0.0.1:${ready.port}/v1"`,
    '-c', 'model_providers.pi_claude.wire_api="responses"',
    '-c', 'model_providers.pi_claude.env_key="CODEX_PI_BRIDGE_TOKEN"',
    '-c', 'model_providers.pi_claude.supports_websockets=false',
    '-c', `model_catalog_json=${JSON.stringify(catalogFile)}`,
    '-c', 'model_reasoning_effort="medium"',
    '-c', 'web_search="disabled"',
    '-m', model,
  ];
  if (userArgs.length === 1 && userArgs[0] === '--check') {
    const health = await fetch(`http://127.0.0.1:${ready.port}/health`, { headers: { authorization: `Bearer ${token}` } });
    if (!health.ok) throw new Error('Bridge health check failed.');
    const check = child('codex', [...config, 'debug', 'models'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let stderr = '';
    check.process.stdout.on('data', chunk => { output += chunk; });
    check.process.stderr.on('data', chunk => { stderr += chunk; });
    if (await check.result !== 0) throw new Error(`Codex catalog check failed: ${stderr}`);
    const parsed = JSON.parse(output);
    const entry = (Array.isArray(parsed) ? parsed : parsed.models).find(item => item.slug === model);
    if (!entry) throw new Error('Codex did not load the Claude catalog.');
    console.log(`Ready: ${model}; medium effort; context ${entry.context_window}; authenticated loopback proxy.`);
    return 0;
  }
  const clientArgs = switching ? await handoff([...config.slice(0, -2), '-c', `model=${JSON.stringify(model)}`], env) : userArgs;
  codex = child('codex', [...config, ...clientArgs], { env, stdio: 'inherit' });
  // If Pi fails during the session, terminate the client instead of leaving it retrying a dead port.
  pi.result.then(() => { if (!closing && codex.process.exitCode === null) codex.process.kill('SIGTERM'); });
  return codex.result;
}
try { process.exitCode = await main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await cleanup(); }
