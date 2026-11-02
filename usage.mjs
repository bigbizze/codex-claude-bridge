// One usage shape for both providers. Both endpoints are undocumented, so every
// reader fails closed: a missing or unknown response gives undefined, never an error.
const HOUR = 3600;
const timeMs = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return value * 1000;
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? undefined : parsed;
};
const window = (id, usedPercent, windowSeconds, resetsAt, scope) =>
  typeof usedPercent === 'number' && Number.isFinite(usedPercent) ? { id, usedPercent, windowSeconds, resetsAt, ...(scope ? { scope } : {}) } : undefined;
const words = value => String(value ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

export function parseClaudeUsage(data) {
  if (!data || typeof data !== 'object' || !('five_hour' in data || 'seven_day' in data)) return undefined;
  const windows = [
    window('five_hour', data.five_hour?.utilization, 5 * HOUR, timeMs(data.five_hour?.resets_at)),
    window('seven_day', data.seven_day?.utilization, 7 * 24 * HOUR, timeMs(data.seven_day?.resets_at)),
    // Scoped limits, for example a weekly limit for one model, can block requests
    // while the two main windows are below 100%.
    ...(Array.isArray(data.limits) ? data.limits : []).filter(limit => !['session', 'weekly_all'].includes(limit?.kind))
      .map(limit => {
        const scope = limit.scope?.model?.id ?? limit.scope?.model?.display_name;
        return window(`${limit.kind}:${scope ?? ''}`, limit.percent, undefined, timeMs(limit.resets_at), scope ? { model: scope } : undefined);
      }),
  ].filter(Boolean);
  return { provider: 'anthropic', windows };
}

export function parseOpenAIUsage(data) {
  if (!data || typeof data !== 'object' || !data.rate_limit) return undefined;
  const fromLimit = (prefix, limit) => ['primary_window', 'secondary_window'].map(name => limit?.[name] &&
    window(`${prefix}${name}`, limit[name].used_percent, limit[name].limit_window_seconds, timeMs(limit[name].reset_at)));
  // additional_rate_limits are other metered features, not Codex model requests.
  return { provider: 'openai', windows: fromLimit('', data.rate_limit).filter(Boolean) };
}

// A scoped window applies when each word of its model name is in the request
// model id, for example scope "Fable" and model "anthropic/claude-fable-5-1".
const applies = (item, model) => !item.scope || (model !== undefined && words(item.scope.model).every(word => words(model).includes(word)));

// A request succeeds only after every full window that applies to it resets, so
// use the latest of those resets.
export function nextReset(usage, now = Date.now(), model) {
  const resets = (usage?.windows ?? []).filter(item => item.usedPercent >= 100 && item.resetsAt > now && applies(item, model)).map(item => item.resetsAt);
  return resets.length ? Math.max(...resets) : undefined;
}

// Codex `additional_rate_limits` entry for `/wham/usage`.
export function codexRateLimit(usage, now = Date.now()) {
  const codexWindow = id => {
    const item = usage.windows.find(entry => entry.id === id);
    // Codex requires reset fields in each window. An invalid window would make
    // Codex reject the whole response, including the ChatGPT limits.
    if (!item || item.resetsAt === undefined) return null;
    const resetAt = Math.floor(item.resetsAt / 1000);
    return { used_percent: Math.round(item.usedPercent), limit_window_seconds: item.windowSeconds,
      reset_at: resetAt, reset_after_seconds: Math.max(0, resetAt - Math.floor(now / 1000)) };
  };
  const limitReached = usage.windows.some(item => item.usedPercent >= 100);
  return { limit_name: 'Claude', metered_feature: 'claude',
    rate_limit: { allowed: !limitReached, limit_reached: limitReached, primary_window: codexWindow('five_hour'), secondary_window: codexWindow('seven_day') } };
}

export function createUsage({ claudeToken, fetchImpl = fetch, ttlMs = 60000, timeoutMs = 5000, now = Date.now, log = () => {} } = {}) {
  const get = async (url, headers, parse) => {
    try {
      const response = await fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) { log(`usage request failed: ${new URL(url).host} ${response.status}`); return undefined; }
      return parse(await response.json());
    } catch (error) { log(`usage request failed: ${new URL(url).host} ${error.message}`); return undefined; }
  };
  let claudeCache;
  return {
    // One shared request and a short cache, because `/status` and the limit wait
    // can ask at the same time.
    claude({ fresh = false } = {}) {
      if (!claudeToken) return Promise.resolve(undefined);
      if (!fresh && claudeCache && now() - claudeCache.at < ttlMs) return claudeCache.value;
      const value = (async () => {
        const token = await claudeToken().catch(() => undefined);
        if (!token) return undefined;
        const usage = await get('https://api.anthropic.com/api/oauth/usage', { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }, parseClaudeUsage);
        if (!usage && claudeCache?.value === value) claudeCache = undefined;
        return usage;
      })();
      claudeCache = { at: now(), value };
      return value;
    },
    // Uses the ChatGPT credentials of the request that hit the limit. API-key
    // accounts have no ChatGPT usage endpoint.
    openai(requestHeaders, { baseUrl = 'https://chatgpt.com/backend-api' } = {}) {
      if (typeof requestHeaders.authorization !== 'string' || typeof requestHeaders['chatgpt-account-id'] !== 'string') return Promise.resolve(undefined);
      const headers = { authorization: requestHeaders.authorization, 'chatgpt-account-id': requestHeaders['chatgpt-account-id'] };
      for (const name of ['originator', 'user-agent']) if (typeof requestHeaders[name] === 'string') headers[name] = requestHeaders[name];
      return get(`${baseUrl}/wham/usage`, headers, parseOpenAIUsage);
    },
  };
}
