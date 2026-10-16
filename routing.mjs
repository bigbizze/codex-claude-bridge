import { once } from 'node:events';
import { fromResponses, toOpenAI } from './history.mjs';

export function openaiRequest(request) {
  return { ...request, model: request.model?.replace(/^openai\//, ''), input: toOpenAI(fromResponses(request.input ?? [])) };
}

export async function forwardOpenAI({ request, headers, response, signal, onActivity, fetchImpl = fetch, baseUrl }) {
  const forwarded = new Headers({ 'content-type': 'application/json', accept: 'text/event-stream' });
  for (const name of ['authorization', 'chatgpt-account-id', 'openai-organization', 'openai-project', 'openai-beta', 'originator', 'version', 'session_id', 'conversation_id', 'x-codex-turn-metadata']) {
    if (typeof headers[name] === 'string') forwarded.set(name, headers[name]);
  }
  if (!forwarded.has('authorization')) throw new Error('OpenAI authentication is missing. Run codex login and restart the bridge.');
  const upstream = baseUrl || (forwarded.has('chatgpt-account-id') ? 'https://chatgpt.com/backend-api/codex' : 'https://api.openai.com/v1');
  const result = await fetchImpl(`${upstream.replace(/\/$/, '')}/responses`, {
    method: 'POST', headers: forwarded, body: JSON.stringify(openaiRequest(request)), signal, redirect: 'error',
  });
  onActivity();
  const responseHeaders = {};
  for (const [name, value] of result.headers) {
    if (['content-type', 'cache-control', 'retry-after', 'www-authenticate', 'x-request-id'].includes(name) || name.startsWith('x-codex-') || name.startsWith('x-ratelimit-')) responseHeaders[name] = value;
  }
  response.writeHead(result.status, responseHeaders);
  if (result.body) {
    for await (const chunk of result.body) {
      onActivity();
      if (!response.write(chunk)) await once(response, 'drain', { signal });
    }
  }
  response.end();
}
