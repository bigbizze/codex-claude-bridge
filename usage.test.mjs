import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  const reader = createUsage({ claudeToken: async () => 'token', fetchImpl: async (url, options) => {
    calls++;
    assert.equal(options.headers['anthropic-beta'], 'oauth-2025-04-20');
    return Response.json(claude);
  } });
  const [first, second] = await Promise.all([reader.claude(), reader.claude()]);
  assert.equal(first, second);
  assert.equal(calls, 1);
  await reader.claude({ fresh: true });
  assert.equal(calls, 2);
  const failing = createUsage({ claudeToken: async () => 'token', fetchImpl: async () => new Response('no', { status: 500 }) });
  assert.equal(await failing.claude(), undefined);
  const throwing = createUsage({ claudeToken: async () => 'token', fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(await throwing.claude(), undefined);
  assert.equal(await throwing.openai({ authorization: 'Bearer api-key' }), undefined);
});
