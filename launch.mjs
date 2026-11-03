import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, chmodSync, mkdtempSync, rmSync, existsSync, linkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHandoff, parseSwitch } from './handoff.mjs';
import { createLocalCertificates } from './certs.mjs';
import { AppServer } from './app-server.mjs';
import { readWarnings } from './warnings.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const model = process.env.CODEX_CLAUDE_MODEL || 'anthropic/claude-opus-5-5';
const userArgs = process.argv.slice(2);
const children = [];
let runtimeDir;
let codex;
let closing;
let handoffClient;
let warningsFile;

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
function printWarnings(warnings) {
  if (warnings.length) console.error(`codex-claude-bridge warnings:\n${warnings.map(line => `  - ${line}`).join('\n')}`);
}
process.on('SIGTERM', () => { const warnings = readWarnings(warningsFile); cleanup().then(() => { printWarnings(warnings); process.exit(143); }); });
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
  const nativeModels = child('codex', ['-c', 'model_provider="openai"', 'debug', 'models', '--bundled'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let nativeCatalogText = '';
  let nativeCatalogError = '';
  nativeModels.process.stdout.on('data', chunk => { nativeCatalogText += chunk; });
  nativeModels.process.stderr.on('data', chunk => { nativeCatalogError += chunk; });
  if (await nativeModels.result !== 0) throw new Error(`Cannot load OpenAI models: ${nativeCatalogError}`);
  const nativeCatalog = JSON.parse(nativeCatalogText);
  const openaiCatalog = { models: Array.isArray(nativeCatalog) ? nativeCatalog : nativeCatalog.models };
  if (!Array.isArray(openaiCatalog.models) || !openaiCatalog.models.length) throw new Error('Codex returned an empty OpenAI model catalog.');
  const openaiCatalogFile = join(runtimeDir, 'openai-models.json');
  writeFileSync(openaiCatalogFile, JSON.stringify(openaiCatalog), { mode: 0o600 });
  const token = randomBytes(32).toString('hex');
  // The proxy secret is in the Codex command line, which other local users can
  // read, so it must not be the bridge token.
  const backendSecret = randomBytes(32).toString('hex');
  const readyFile = join(runtimeDir, 'ready.json');
  warningsFile = join(runtimeDir, 'warnings.log');
  const env = { ...process.env, CODEX_PI_BRIDGE_TOKEN: token, CODEX_PI_STATE_KEY_FILE: keyFile, CODEX_PI_READY_FILE: readyFile, CODEX_PI_OPENAI_CATALOG: openaiCatalogFile,
    CODEX_PI_WARNINGS_FILE: warningsFile, CODEX_PI_BACKEND_SECRET: backendSecret };
  // Claude limits in /status need a local HTTPS ChatGPT backend. Without openssl
  // the bridge still works, and /status shows ChatGPT limits only.
  let certificates;
  if (process.env.CODEX_BRIDGE_STATUS !== '0') {
    try { certificates = await createLocalCertificates(runtimeDir); }
    catch (error) { console.error(`Claude limits will not show in /status: cannot create a local certificate (${error.code === 'ENOENT' ? 'openssl is not installed' : error.message}).`); }
  }
  if (certificates) Object.assign(env, { CODEX_PI_TLS_KEY: certificates.key, CODEX_PI_TLS_CERT: certificates.cert });
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
  if (ready.backendPort) {
    env.CODEX_CA_CERTIFICATE = certificates.ca;
  }
  delete env.CODEX_PI_TLS_KEY; delete env.CODEX_PI_TLS_CERT; delete env.CODEX_PI_BACKEND_SECRET;
  const catalogFile = join(runtimeDir, 'models.json');
  writeFileSync(catalogFile, JSON.stringify(ready.catalog), { mode: 0o600 });
  const config = [
    '-c', 'model_provider="pi_claude"',
    '-c', 'model_providers.pi_claude.name="Pi Claude"',
    '-c', `model_providers.pi_claude.base_url="http://127.0.0.1:${ready.port}/v1"`,
    '-c', 'model_providers.pi_claude.wire_api="responses"',
    '-c', 'model_providers.pi_claude.requires_openai_auth=true',
    '-c', 'model_providers.pi_claude.env_http_headers={"x-codex-bridge-token"="CODEX_PI_BRIDGE_TOKEN"}',
    '-c', 'model_providers.pi_claude.supports_websockets=false',
    '-c', `model_catalog_json=${JSON.stringify(catalogFile)}`,
    '-c', 'model_reasoning_effort="medium"',
    '-c', 'web_search="disabled"',
    ...(ready.backendPort ? ['-c', `chatgpt_base_url="https://localhost:${ready.backendPort}/${backendSecret}/backend-api/"`] : []),
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
    const missing = openaiCatalog.models.filter(item => !(Array.isArray(parsed) ? parsed : parsed.models).some(loaded => loaded.slug === `openai/${item.slug}`));
    if (missing.length) throw new Error(`Codex did not load OpenAI models: ${missing.map(item => item.slug).join(', ')}`);
    console.log(`Ready: ${model}; medium effort; context ${entry.context_window}; ${openaiCatalog.models.length} OpenAI models; authenticated loopback proxy.`);
    return await checkUsage(ready, token, config.slice(0, -2), env) ? 0 : 1;
  }
  const clientArgs = switching ? await handoff([...config.slice(0, -2), '-c', `model=${JSON.stringify(model)}`], env) : userArgs;
  codex = child('codex', [...config, ...clientArgs], { env, stdio: 'inherit' });
  // If Pi fails during the session, terminate the client instead of leaving it retrying a dead port.
  pi.result.then(() => { if (!closing && codex.process.exitCode === null) codex.process.kill('SIGTERM'); });
  return codex.result;
}

// Reads usage only. It makes no model request, so it uses no model quota.
async function checkUsage(ready, token, config, env) {
  const percent = window => window ? `${Math.round(window.usedPercent)}%` : 'none';
  const usage = await fetch(`http://127.0.0.1:${ready.port}/usage`, { headers: { authorization: `Bearer ${token}` } }).then(response => response.json());
  const claude = usage.claude?.windows ?? [];
  console.log(usage.claude
    ? `Claude usage: OK; 5-hour ${percent(claude.find(item => item.id === 'five_hour'))}, weekly ${percent(claude.find(item => item.id === 'seven_day'))}.`
    : 'Claude usage: unavailable.');
  if (!ready.backendPort) console.log('/status proxy: off (CODEX_BRIDGE_STATUS=0 or no openssl).');
  else {
    const client = new AppServer(config, { env });
    try {
      await client.initialize();
      const limits = await client.call('account/rateLimits/read');
      const shown = Object.entries(limits.rateLimitsByLimitId ?? {}).some(([id, item]) => id === 'claude' || item?.limitName === 'Claude');
      if (shown || !usage.claude?.windows.length) console.log(`/status proxy: OK; ChatGPT limits read${shown ? '; Claude row shown' : ''}.`);
      else { console.log('/status proxy: Codex did not read the Claude row. Codex changed how it reads limits; the bridge needs an update.'); return false; }
    } catch (error) {
      console.log(`/status proxy: ChatGPT limits not read (${error.message}). API-key accounts have no ChatGPT limits.`);
    } finally { await client.close(); }
  }
  return readWarnings(warningsFile).length === 0;
}

try { process.exitCode = await main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  const warnings = readWarnings(warningsFile);
  await cleanup();
  printWarnings(warnings);
}
