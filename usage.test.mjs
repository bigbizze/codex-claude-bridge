import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeUsage, parseOpenAIUsage, nextReset, codexRateLimit, createUsage } from './usage.mjs';

// Shapes recorded from the live endpoints on 2026-11-02, with unused fields removed.
const claude = {
  five_hour: { utilization: 41.0, resets_at: '2026-11-03T00:10:00.349301+00:00' },
  seven_day: { utilization: 70.0, resets_at: '2026-11-03T08:00:00.349323+00:00' },
  seven_day_opus: null,
  limits: [
    { kind: 'session', percent: 41, resets_at: '2026-11-03T00:10:00.349301+00:00', scope: null },
    { kind: 'weekly_all', percent: 70, resets_at: '2026-11-03T08:00:00.349323+00:00', scope: null },
    { kind: 'weekly_scoped', percent: 45, resets_at: '2026-11-03T08:00:00.349470+00:00', scope: { model: { id: null, display_name: 'Fable' } } },
  ],
};
const openai = {
  plan_type: 'pro',
  rate_limit: { allowed: true, limit_reached: false, secondary_window: null,
    primary_window: { used_percent: 19, limit_window_seconds: 604800, reset_after_seconds: 137968, reset_at: 1793797146 } },
  additional_rate_limits: null,
};
const now = Date.parse('2026-11-02T23:00:00Z');

test('both providers parse into one shape and find the reset of a full window', () => {
  const parsed = parseClaudeUsage(claude);
  assert.deepEqual(parsed.windows.map(item => [item.id, item.usedPercent]), [['five_hour', 41], ['seven_day', 70], ['weekly_scoped:Fable', 45]]);
  assert.equal(parsed.windows[0].resetsAt, Date.parse('2026-11-03T00:10:00.349Z'));
  assert.equal(nextReset(parsed, now), undefined);
  // A full scoped limit blocks only its own model.
  const scopedFull = parseClaudeUsage({ ...claude, limits: [{ ...claude.limits[2], percent: 100 }] });
  assert.equal(nextReset(scopedFull, now, 'anthropic/claude-fable-5-1'), Date.parse('2026-11-03T08:00:00.349Z'));
  assert.equal(nextReset(scopedFull, now, 'anthropic/claude-opus-5-5'), undefined);
  const sessionFull = parseClaudeUsage({ ...claude, five_hour: { ...claude.five_hour, utilization: 100 } });
  assert.equal(nextReset(sessionFull, now, 'anthropic/claude-opus-5-5'), Date.parse('2026-11-03T00:10:00.349Z'));
  // Unknown limit kinds without a model scope cannot block a request.
  const unknownFull = parseClaudeUsage({ ...claude, limits: [{ kind: 'new_kind', percent: 100, resets_at: '2026-11-09T00:00:00Z', scope: null }] });
  assert.equal(nextReset(unknownFull, now, 'anthropic/claude-opus-5-5'), undefined);
  // With two full windows, the request can succeed only after the later reset.
  const bothFull = parseClaudeUsage({ ...claude, five_hour: { ...claude.five_hour, utilization: 100 }, seven_day: { ...claude.seven_day, utilization: 100 } });
  assert.equal(nextReset(bothFull, now), Date.parse('2026-11-03T08:00:00.349Z'));

  const gpt = parseOpenAIUsage({ ...openai, rate_limit: { ...openai.rate_limit, primary_window: { ...openai.rate_limit.primary_window, used_percent: 100 } },
    additional_rate_limits: [{ metered_feature: 'other', rate_limit: { primary_window: { used_percent: 100, reset_at: 1893797146 } } }] });
  assert.equal(gpt.windows.length, 1);
  assert.equal(nextReset(gpt, now), 1793797146000);
  assert.equal(nextReset(parseOpenAIUsage(openai), now), undefined);
  assert.equal(parseClaudeUsage({ error: 'x' }), undefined);
  assert.equal(parseOpenAIUsage({}), undefined);
});

test('Claude usage becomes a Codex additional_rate_limits entry', () => {
  const entry = codexRateLimit(parseClaudeUsage(claude), now);
  assert.equal(entry.metered_feature, 'claude');
  assert.equal(entry.rate_limit.limit_reached, false);
  assert.deepEqual(entry.rate_limit.primary_window, { used_percent: 41, limit_window_seconds: 18000, reset_at: 1793664600, reset_after_seconds: 4200 });
  assert.equal(entry.rate_limit.secondary_window.limit_window_seconds, 604800);
  assert.equal(codexRateLimit(parseClaudeUsage({ five_hour: null, seven_day: claude.seven_day }), now).rate_limit.primary_window, null);
  // A full limit of another model does not mark Claude as limited.
  assert.equal(codexRateLimit(parseClaudeUsage({ ...claude, limits: [{ ...claude.limits[2], percent: 100 }] }), now).rate_limit.limit_reached, false);
  // Codex rejects a window without reset fields, so such a window must be null.
  assert.equal(codexRateLimit(parseClaudeUsage({ ...claude, five_hour: { utilization: 0, resets_at: null } }), now).rate_limit.primary_window, null);
});

test('usage requests fail closed and share one cached Claude request', async () => {
  let calls = 0;
  let clock = now;
  const reader = createUsage({ claudeToken: async () => 'token', now: () => clock, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(options.headers['anthropic-beta'], 'oauth-2025-04-20');
    return Response.json(claude);
  } });
  const [first, second] = await Promise.all([reader.claude(), reader.claude()]);
  assert.equal(first, second);
  assert.equal(calls, 1);
  // A fresh read skips the cache, but not the minimum interval between requests.
  await reader.claude({ fresh: true });
  assert.equal(calls, 1);
  clock += 30000;
  await reader.claude({ fresh: true });
  assert.equal(calls, 2);
  const warnings = [];
  const warn = message => warnings.push(message);
  const failing = createUsage({ claudeToken: async () => 'token', warn, fetchImpl: async () => new Response('no', { status: 500 }) });
  assert.equal(await failing.claude(), undefined);
  const throwing = createUsage({ claudeToken: async () => 'token', warn, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(await throwing.claude(), undefined);
  assert.equal(await throwing.openai({ authorization: 'Bearer api-key' }), undefined);
  // Temporary failures are not warnings. A changed format or a removed endpoint is.
  assert.deepEqual(warnings, []);
  for (const body of [{ usage: { five_hour: 41 } }, { five_hour: { used: 41 }, seven_day: null }]) {
    assert.equal(await createUsage({ claudeToken: async () => 'token', warn, fetchImpl: async () => Response.json(body) }).claude(), undefined);
  }
  await createUsage({ claudeToken: async () => 'token', warn, fetchImpl: async () => new Response('gone', { status: 404 }) }).claude();
  // A rejected login and inactive limits are not format changes.
  await createUsage({ claudeToken: async () => 'token', warn, fetchImpl: async () => new Response('no', { status: 401 }) }).claude();
  assert.deepEqual((await createUsage({ claudeToken: async () => 'token', warn, fetchImpl: async () => Response.json({ five_hour: null, seven_day: null }) }).claude()).windows, []);
  await createUsage({ warn, fetchImpl: async () => Response.json({ limits: [] }) }).openai({ authorization: 'Bearer chatgpt', 'chatgpt-account-id': 'account' });
  assert.deepEqual(warnings.map(line => line.split('.')[0]), ['Claude usage format changed', 'Claude usage format changed', 'Claude usage endpoint returned HTTP 404', 'ChatGPT usage format changed']);
  // A failed fresh read during a limit wait uses the last good reading.
  let up = true;
  const flaky = createUsage({ claudeToken: async () => 'token', fetchImpl: async () => up ? Response.json(claude) : new Response('busy', { status: 429 }) });
  const good = await flaky.claude();
  up = false;
  assert.equal(await flaky.claude({ fresh: true }), good);
});

test('Claude usage is shared across sessions and backs off after a rate limit', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cacheFile = join(dir, 'claude-usage.json');
  let clock = now;
  let status = 200;
  let calls = 0;
  const fetchImpl = async () => { calls++; return status === 200 ? Response.json(claude) : new Response('limited', { status, headers: { 'retry-after': '0' } }); };
  const session = () => createUsage({ claudeToken: async () => 'token', cacheFile, fetchImpl, now: () => clock });
  const [one, two] = [session(), session()];
  // The file has no undefined fields, which nextReset and codexRateLimit treat the same way.
  const plain = value => value && JSON.parse(JSON.stringify(value));
  const good = plain(await one.claude());
  assert.equal(statSync(cacheFile).mode & 0o777, 0o600);
  // Another session uses the reading of the first one, even for a fresh read.
  assert.deepEqual(plain(await two.claude()), good);
  assert.deepEqual(plain(await two.claude({ fresh: true })), good);
  assert.equal(calls, 1);
  // A 429 starts a backoff for every session. The last good reading stays in use.
  status = 429;
  clock += 60000;
  assert.deepEqual(plain(await two.claude({ fresh: true })), good);
  assert.equal(calls, 2);
  assert.deepEqual(one.claudeState(), { at: now, backoffUntil: clock + 60000, failure: 429 });
  clock += 59000;
  assert.deepEqual(plain(await one.claude({ fresh: true })), good);
  assert.equal(calls, 2);
  // Each further failure doubles the backoff.
  clock += 1000;
  await one.claude({ fresh: true });
  assert.equal(calls, 3);
  assert.equal(two.claudeState().backoffUntil, clock + 120000);
  // After 10 minutes the old reading is not used, and success ends the backoff.
  clock += 120000;
  status = 200;
  assert.deepEqual(plain(await two.claude({ fresh: true })), good);
  assert.equal(calls, 4);
  assert.deepEqual(one.claudeState(), { at: clock, backoffUntil: null, failure: null });
  status = 429;
  clock += 30000;
  await one.claude({ fresh: true });
  clock += 11 * 60000;
  assert.equal(await two.claude({ fresh: true }), undefined);
  // A reading made with another login is not used.
  status = 200;
  clock += 30 * 60000;
  await one.claude();
  const other = createUsage({ claudeToken: async () => 'other-token', cacheFile, fetchImpl: async () => new Response('limited', { status: 429 }), now: () => clock });
  assert.equal(await other.claude(), undefined);
});
