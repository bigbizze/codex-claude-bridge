const tiers = { anthropic: ['fable', 'opus', 'sonnet', 'haiku'], openai: ['astra', 'sol', 'terra', 'luna'] };

function version(entry, provider) {
  const slug = entry.slug.replace(`${provider}/`, '');
  const match = provider === 'anthropic'
    ? /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-(\d{8}))?$/.exec(slug)
    : /^gpt-(\d+)(?:\.(\d+))?(?:-([a-z][a-z0-9-]*))?$/.exec(slug);
  if (!match) return null;
  return provider === 'anthropic'
    ? { family: match[1], major: Number(match[2]), minor: Number(match[3] || 0), dated: Boolean(match[4]) }
    : { family: match[3] || 'default', major: Number(match[1]), minor: Number(match[2] || 0), dated: false };
}

const providerPriority = (left, right) => (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER);
const newest = (left, right) => right.major - left.major || right.minor - left.minor || Number(left.dated) - Number(right.dated);
const tier = (family, provider) => {
  const index = tiers[provider].indexOf(family.split('-')[0]);
  return index < 0 ? tiers[provider].length : index;
};

function ordered(models, provider) {
  const parsed = models.map(entry => ({ entry, version: version(entry, provider) }));
  const visible = parsed.filter(item => item.version && item.entry.visibility !== 'hide');
  const generation = Math.max(...visible.map(item => item.version.major));
  const latest = new Map();
  for (const item of visible) {
    if (provider === 'openai' && item.version.major !== generation) continue;
    const previous = latest.get(item.version.family);
    if (!previous || newest(item.version, previous.version) < 0) latest.set(item.version.family, item);
  }
  const featured = [...latest.values()].sort((left, right) => tier(left.version.family, provider) - tier(right.version.family, provider)
    || providerPriority(left.entry, right.entry)).map(item => item.entry);
  const selected = new Set(featured);
  const remaining = parsed.filter(item => !selected.has(item.entry)).sort((left, right) => {
    if (provider === 'anthropic' && left.version && right.version) {
      return tier(left.version.family, provider) - tier(right.version.family, provider)
        || newest(left.version, right.version) || providerPriority(left.entry, right.entry);
    }
    if (provider === 'anthropic' && Boolean(left.version) !== Boolean(right.version)) return left.version ? -1 : 1;
    return providerPriority(left.entry, right.entry);
  }).map(item => item.entry);
  return { featured, remaining };
}

export function mergeCatalogs(claude, openai) {
  const seen = new Set();
  const qualify = (models, provider) => models.map(entry => {
    const slug = entry.slug.startsWith(`${provider}/`) ? entry.slug : `${provider}/${entry.slug}`;
    if (seen.has(slug)) throw new Error(`Duplicate model in bridge catalog: ${slug}`);
    seen.add(slug);
    return { ...entry, slug, display_name: slug };
  });
  const anthropic = ordered(qualify(claude.models, 'anthropic'), 'anthropic');
  const native = ordered(qualify(openai.models, 'openai'), 'openai');
  return { models: [...anthropic.featured, ...native.featured, ...anthropic.remaining, ...native.remaining]
    .map((entry, priority) => ({ ...entry, priority })) };
}
