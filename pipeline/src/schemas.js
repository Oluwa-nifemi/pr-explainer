const str = { type: 'string' };
const strArr = { type: 'array', items: str };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const objSome = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const nullable = (schema) => ({ anyOf: [{ type: 'null' }, schema] });

export const KIND_ENUM = ['contract', 'core-logic', 'wiring', 'ui', 'tests', 'config', 'refactor', 'docs'];

export const diagramSchema = obj({
  title: str,
  nodes: {
    type: 'array',
    minItems: 3,
    maxItems: 6,
    items: objSome({
      id: str,
      label: str,
      kind: { type: 'string', enum: ['step', 'decision', 'end'] },
      change: { type: 'string', enum: ['added', 'modified', 'removed', 'unchanged'] },
      layer: { type: 'integer' },
      path: str,
    }, ['id', 'label', 'kind', 'change', 'layer']),
  },
  edges: {
    type: 'array',
    items: objSome({ from: str, to: str, label: str }, ['from', 'to']),
  },
});

export const diagramFixSchema = { name: 'pr_diagram_fix', schema: obj({ diagram: nullable(diagramSchema) }) };

export const summaryFields = {
  why: str,
  whatChanged: strArr,
  risk: { type: 'string', enum: ['low', 'medium', 'high'] },
  riskReason: str,
  reviewMinutes: { type: 'integer' },
};

export const summarySchema = { name: 'pr_summary', schema: obj(summaryFields) };

const planStep = obj({
  title: str,
  kind: { type: 'string', enum: KIND_ENUM },
  summary: str,
  dependsOn: { type: 'array', items: { type: 'integer' } },
  hunks: strArr,
});
export const planSchema = { name: 'pr_plan', schema: obj({ steps: { type: 'array', minItems: 1, maxItems: 10, items: planStep } }) };

export const hunkNotesField = { type: 'array', items: obj({ hunk: str, note: str }) };

export const branchesField = {
  type: 'array',
  items: obj({
    condition: str,
    outcome: str,
    changed: { type: 'boolean' },
  }),
};

export const workerFields = {
  gist: str,
  branches: branchesField,
  diagram: nullable(diagramSchema),
  hunkNotes: hunkNotesField,
};
export const workerSchema = { name: 'pr_step', schema: obj(workerFields) };

export const inlineWorkerFields = {
  draft: str,
  missing: strArr,
  gist: str,
  branches: branchesField,
  diagram: nullable(diagramSchema),
  hunkNotes: hunkNotesField,
};
export const inlineWorkerSchema = { name: 'pr_step_inline', schema: obj(inlineWorkerFields) };

export const gistReviewSchema = { name: 'pr_gist_review', schema: obj({ missing: strArr, gist: str }) };

export const GIST_MODES = ['none', 'inline', 'review'];
export const DEFAULT_GIST_MODE = 'inline';

export function gistMode() {
  const m = process.env.PRX_GIST_MODE;
  return GIST_MODES.includes(m) ? m : DEFAULT_GIST_MODE;
}

export const singleShotSchema = {
  name: 'pr_story',
  schema: obj({
    summary: obj(summaryFields),
    steps: {
      type: 'array',
      items: obj({
        title: str,
        kind: { type: 'string', enum: KIND_ENUM },
        summary: str,
        dependsOn: { type: 'array', items: { type: 'integer' } },
        hunks: strArr,
        gist: str,
        branches: branchesField,
        diagram: nullable(diagramSchema),
        hunkNotes: hunkNotesField,
      }),
    },
  }),
};
