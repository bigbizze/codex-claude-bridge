import { nextReset } from './usage.mjs';

const MINUTE = 60000;

export function parseDuration(value) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h)?\s*$/i.exec(value ?? '');
  if (!match) return undefined;
  return Number(match[1]) * { s: 1000, m: MINUTE, h: 60 * MINUTE }[(match[2] || 'm').toLowerCase()];
}

export function waitPolicy(env = process.env) {
  return {
    anthropic: env.CODEX_BRIDGE_WAIT_CLAUDE !== '0',
    // A held OpenAI 429 hides Codex's own limit handling, such as the model
    // switch offer, so this is opt-in.
    openai: env.CODEX_BRIDGE_WAIT_OPENAI === '1',
    maxWaitMs: parseDuration(env.CODEX_BRIDGE_WAIT_MAX) ?? 6 * 60 * MINUTE,
    marginMs: 30000,
    maxCycles: 3,
  };
}

// Short steps instead of one long timer, so a suspended computer resumes on the
// wall clock instead of the remaining timer duration.
export function sleepUntil(target, signal, { now = Date.now, stepMs = MINUTE } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    let timer;
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const step = () => {
      const remaining = target - now();
      if (remaining <= 0) { signal?.removeEventListener('abort', onAbort); return resolve(); }
      timer = setTimeout(step, Math.min(remaining, stepMs));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    step();
  });
}

const clock = time => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// One gate per Codex request. It returns true after a wait, so the caller sends
// the same request again, or false when the caller must return the original error.
export function createLimitWait({ policy, signal, pauseIdle = () => {}, resumeIdle = () => {}, log = console.error, now = Date.now, stepMs }) {
  let cycles = 0;
  return async ({ provider, label, resetAt }) => {
    if (!policy[provider] || cycles >= policy.maxCycles || signal.aborted) return false;
    const resetsAt = await resetAt();
    if (resetsAt === undefined || signal.aborted) return false;
    const target = resetsAt + policy.marginMs;
    const waitMs = target - now();
    if (waitMs > policy.maxWaitMs) {
      log(`[pi-codex] ${label} usage limit reached; reset at ${clock(resetsAt)} is later than the maximum wait`);
      return false;
    }
    cycles++;
    log(`[pi-codex] ${label} usage limit reached; waiting until ${clock(target)} (${Math.max(1, Math.round(waitMs / MINUTE))} min)`);
    pauseIdle();
    try { await sleepUntil(target, signal, { now, stepMs }); }
    finally { resumeIdle(); }
    log(`[pi-codex] ${label} usage limit wait ended; sending the request again`);
    return true;
  };
}

export const isRateLimitError = message => /\b429\b|rate_limit_error|rate.limit.exceeded/i.test(message);

// Pi rejects a retry-after above its 60 s maximum with this message. Use it only
// when the usage endpoint is unavailable.
export async function claudeResetAt({ usage, error, model, now = Date.now }) {
  const reset = nextReset(await usage?.claude({ fresh: true }), now(), model);
  if (reset !== undefined) return reset;
  const seconds = /Server requested (\d+)s retry delay/.exec(error.message)?.[1];
  return seconds ? now() + Number(seconds) * 1000 : undefined;
}

export async function openaiResetAt({ usage, body, headers, requestHeaders, now = Date.now }) {
  let error;
  try { error = JSON.parse(body)?.error; } catch {}
  if (error?.type === 'usage_limit_reached') {
    if (Number.isFinite(error.resets_at)) return error.resets_at * 1000;
    if (Number.isFinite(error.resets_in_seconds)) return now() + error.resets_in_seconds * 1000;
  }
  const reset = nextReset(await usage?.openai(requestHeaders), now());
  if (reset !== undefined) return reset;
  const retryAfter = Number(headers.get('retry-after'));
  return error?.type === 'usage_limit_reached' && retryAfter > 0 ? now() + retryAfter * 1000 : undefined;
}
