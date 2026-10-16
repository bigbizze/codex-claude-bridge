import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCatalogs } from './model-catalog.mjs';

const catalog = slugs => ({ models: slugs.map((slug, priority) => ({ slug, priority, visibility: 'list' })) });

test('latest Anthropic families precede latest OpenAI families, then each provider has its own older group', () => {
  const claude = catalog([
    'anthropic/claude-haiku-4-5', 'anthropic/claude-opus-4-8', 'anthropic/claude-fable-5',
    'anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5', 'anthropic/claude-haiku-5-5',
    'anthropic/claude-fable-5-1', 'anthropic/claude-opus-5',
  ]);
  const openai = catalog(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra']);
  const models = mergeCatalogs(claude, openai).models;
  assert.deepEqual(models.map(entry => entry.slug), [
    'anthropic/claude-fable-5-1', 'anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5', 'anthropic/claude-haiku-5-5',
    'openai/gpt-6-astra', 'openai/gpt-6.1-sol', 'openai/gpt-6-luna',
    'anthropic/claude-fable-5', 'anthropic/claude-opus-5', 'anthropic/claude-opus-4-8', 'anthropic/claude-haiku-4-5',
    'openai/gpt-6-sol', 'openai/gpt-5.6-sol', 'openai/gpt-5.6-terra',
  ]);
  assert.deepEqual(models.map(entry => entry.display_name), models.map(entry => entry.slug));
  assert.deepEqual(models.map(entry => entry.priority), models.map((_, index) => index));
});

test('latest groups are inferred from available models without inventing missing releases or featuring hidden entries', () => {
  const claude = catalog(['anthropic/claude-opus-5', 'anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5', 'anthropic/claude-haiku-4-5-20251001', 'anthropic/claude-haiku-4-5']);
  const openai = catalog(['gpt-6.1-sol', 'gpt-6.2-sol', 'gpt-6-astra', 'gpt-5.6-terra']);
  openai.models.push({ slug: 'gpt-7-astra', visibility: 'hide', priority: 0 });
  const models = mergeCatalogs(claude, openai).models;
  assert.deepEqual(models.slice(0, 5).map(entry => entry.slug), [
    'anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5', 'anthropic/claude-haiku-4-5',
    'openai/gpt-6-astra', 'openai/gpt-6.2-sol',
  ]);
  assert.equal(models.find(entry => entry.slug === 'openai/gpt-7-astra').visibility, 'hide');
  assert.equal(models.length, claude.models.length + openai.models.length);
});

test('catalog customization retains provider metadata, uses provider priority for older OpenAI models and does not mutate sources', () => {
  const claude = catalog(['anthropic/claude-opus-5-5']);
  const openai = { models: [
    { slug: 'gpt-5.6-luna', priority: 9 },
    { slug: 'gpt-6-astra', priority: 2, context_window: 400000, supported_reasoning_levels: [{ effort: 'max' }], model_messages: { instructions_template: 'Native instructions' } },
    { slug: 'gpt-5.6-sol', priority: 5 },
  ] };
  const before = structuredClone({ claude, openai });
  const models = mergeCatalogs(claude, openai).models;
  assert.deepEqual(models.map(entry => entry.slug), ['anthropic/claude-opus-5-5', 'openai/gpt-6-astra', 'openai/gpt-5.6-sol', 'openai/gpt-5.6-luna']);
  assert.equal(models[1].context_window, 400000);
  assert.deepEqual(models[1].supported_reasoning_levels, [{ effort: 'max' }]);
  assert.deepEqual(models[1].model_messages, openai.models[1].model_messages);
  assert.deepEqual({ claude, openai }, before);
  assert.throws(() => mergeCatalogs(claude, catalog(['gpt-6-astra', 'openai/gpt-6-astra'])), /Duplicate/);
});
