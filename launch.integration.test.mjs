import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('launcher starts real Pi and Codex with the combined model catalog', { skip: process.env.CODEX_ROUTING_INTEGRATION !== '1', timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-launch-integration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const codexHome = join(dir, 'codex');
  await mkdir(codexHome);
  await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'test-openai-key' }), { mode: 0o600 });
  const { stdout } = await promisify(execFile)(process.execPath, [new URL('./launch.mjs', import.meta.url).pathname, '--check'], {
    cwd: dir, timeout: 40000, env: { ...process.env, CODEX_HOME: codexHome, PI_CODING_AGENT_DIR: join(dir, 'pi'),
      XDG_STATE_HOME: join(dir, 'state'), ANTHROPIC_API_KEY: 'test-anthropic-key', OPENAI_API_KEY: 'test-openai-key' },
  });
  assert.match(stdout, /Ready: anthropic\//);
  assert.match(stdout, /[1-9]\d* OpenAI models/);
});
