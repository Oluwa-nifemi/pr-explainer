// Story model profiles. Each one names a model and the provider that serves it.
// PR_EXPLAINER_FAST_MODEL and PR_EXPLAINER_STRONG_MODEL are served by LiteLLM.
// PR_EXPLAINER_CLAUDE_MODEL and PR_EXPLAINER_CLAUDE_SONNET_MODEL are served by the Claude Code bridge.
// PR_EXPLAINER_STRONG_MODEL_BODY is an optional JSON object merged into every request for the strong model.
const fastModel = process.env.PR_EXPLAINER_FAST_MODEL || 'deepseek-chat';
const strongModel = process.env.PR_EXPLAINER_STRONG_MODEL || 'claude-opus-4-5';
const claudeModel = process.env.PR_EXPLAINER_CLAUDE_MODEL || 'claude-code-opus';
const claudeSonnetModel = process.env.PR_EXPLAINER_CLAUDE_SONNET_MODEL || 'claude-code-sonnet';

function jsonEnv(name) {
  try {
    const v = JSON.parse(process.env[name] || '');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export const PROVIDERS = {
  litellm: { label: 'LiteLLM', envName: 'PR_EXPLAINER_LITELLM_BASE_URL' },
  'claude-code': { label: 'Claude Code', envName: 'PR_EXPLAINER_CLAUDE_BASE_URL' },
};

export const MODELS = {
  deepseek: {
    provider: 'litellm',
    option: 'DeepSeek',
    model: fastModel,
    label: fastModel,
    reasoning: { story: 'none', chat: 'medium' },
    chat: true,
  },
  opus: {
    provider: 'litellm',
    option: 'Opus',
    model: strongModel,
    label: strongModel,
    body: jsonEnv('PR_EXPLAINER_STRONG_MODEL_BODY'),
    reasoning: { story: null, chat: 'medium' },
    maxConcurrency: 4,
    dropSchemaKeys: ['minItems', 'maxItems'],
    chat: true,
  },
  claude: {
    provider: 'claude-code',
    option: 'Opus (Claude Code)',
    model: claudeModel,
    label: claudeModel,
    reasoning: { story: null, chat: null },
    dropSchemaKeys: ['minItems', 'maxItems'],
  },
  'claude-sonnet': {
    provider: 'claude-code',
    option: 'Sonnet (Claude Code)',
    model: claudeSonnetModel,
    label: claudeSonnetModel,
    reasoning: { story: null, chat: null },
    dropSchemaKeys: ['minItems', 'maxItems'],
  },
};

export const providerOf = (name) => MODELS[name]?.provider || 'litellm';
export const modelsFor = (provider) => Object.keys(MODELS).filter((name) => providerOf(name) === provider);
export const chatModels = () => Object.keys(MODELS).filter((name) => MODELS[name].chat);

let storyModel = MODELS[process.env.PR_EXPLAINER_STORY_MODEL] ? process.env.PR_EXPLAINER_STORY_MODEL : 'deepseek';

export const getStoryModel = () => storyModel;

export function setStoryModel(name) {
  if (MODELS[name]) storyModel = name;
}

export function requestFields(name, use, thinking) {
  const m = MODELS[name] || MODELS.deepseek;
  const effort = thinking && thinking !== 'default' ? thinking : m.reasoning[use];
  return { model: m.model, ...m.body, ...(effort ? { reasoning_effort: effort } : {}) };
}

export function schemaFor(name, schema) {
  const drop = MODELS[name]?.dropSchemaKeys;
  if (!drop) return schema;
  const strip = (v) =>
    Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !drop.includes(k)).map(([k, x]) => [k, strip(x)])) : v;
  return strip(schema);
}

export function logCall(name, label) {
  console.error('[pr-explainer] llm ' + name + ' ' + label);
}
