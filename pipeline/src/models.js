// Two model profiles. The ids are the model names your LiteLLM gateway serves.
// PR_EXPLAINER_FAST_MODEL and PR_EXPLAINER_STRONG_MODEL change them.
// PR_EXPLAINER_STRONG_MODEL_BODY is an optional JSON object merged into every request for the strong model.
const fastModel = process.env.PR_EXPLAINER_FAST_MODEL || 'deepseek-chat';
const strongModel = process.env.PR_EXPLAINER_STRONG_MODEL || 'claude-opus-4-5';

function jsonEnv(name) {
  try {
    const v = JSON.parse(process.env[name] || '');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export const MODELS = {
  deepseek: {
    model: fastModel,
    label: fastModel,
    reasoning: { story: 'none', chat: 'medium' },
  },
  opus: {
    model: strongModel,
    label: strongModel,
    body: jsonEnv('PR_EXPLAINER_STRONG_MODEL_BODY'),
    reasoning: { story: null, chat: 'medium' },
    maxConcurrency: 4,
    dropSchemaKeys: ['minItems', 'maxItems'],
  },
};

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
