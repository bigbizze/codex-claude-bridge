import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCatalogs } from './model-catalog.mjs';

const catalog = slugs => ({ models: slugs.map((slug, priority) => ({ slug, priority, visibility: 'list' })) });

test('unknown families and naming conventions appear between latest and legacy groups without suppressing latest models', () => {
  const claude = catalog(['claude-opus-5', 'claude-nova-9', 'claude-opus-5-5', 'claude-3-7-sonnet-latest', 'new-anthropic-name']);
  const openai = catalog(['gpt-5.6-sol', 'gpt-9-nebula', 'gpt-6-astra', 'new-openai-name', 'gpt-4o']);
  const models = mergeCatalogs(claude, openai).models;
  assert.deepEqual(models.map(entry => entry.slug), [
    'anthropic/claude-opus-5-5', 'openai/gpt-6-astra',
    'anthropic/claude-nova-9', 'anthropic/new-anthropic-name',
    'openai/gpt-9-nebula', 'openai/new-openai-name',
    'anthropic/claude-opus-5', 'anthropic/claude-3-7-sonnet-latest',
    'openai/gpt-5.6-sol', 'openai/gpt-4o',
  ]);
  assert.equal(models.length, claude.models.length + openai.models.length);
});

test('unknown-only catalogs preserve provider priority, visibility and metadata without a recognized latest group', () => {
  const claude = catalog(['claude-new-family']);
  const openai = { models: [
    { slug: 'future-model', priority: 8, visibility: 'list', context_window: 800000 },
    { slug: 'future-hidden', priority: 1, visibility: 'hide' },
  ] };
  const before = structuredClone({ claude, openai });
  const models = mergeCatalogs(claude, openai).models;
  assert.deepEqual(models.map(entry => entry.slug), ['anthropic/claude-new-family', 'openai/future-hidden', 'openai/future-model']);
  assert.equal(models[1].visibility, 'hide');
  assert.equal(models[2].context_window, 800000);
  assert.deepEqual({ claude, openai }, before);
  assert.deepEqual(mergeCatalogs(catalog([]), catalog([])), { models: [] });
});

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
