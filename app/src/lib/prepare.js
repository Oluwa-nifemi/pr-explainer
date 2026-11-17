import { diagramTarget } from "../../../pipeline/src/diagram-target.js";

// Tests and docs leave the walkthrough and go to one closing section. Steps left with no hunks are dropped.
const TEST_RE = /(\.test\.|\.spec\.|__tests__\/|(^|\/)tests?\/|(^|\/)test_[^/]*\.py$|_test\.(py|go)$)/;
const DOC_RE = /\.(md|mdx|rst)$/i;

export const extraKind = (path) => (TEST_RE.test(path) ? "test" : DOC_RE.test(path) ? "doc" : null);

const CONFIG_RE = /(\.(json|ya?ml|toml|ini|cfg|env)$|(^|\/)(Dockerfile|Makefile)$|\.config\.[a-z]+$)/i;
const GENERATED_RE = /(\.lock$|-lock\.|\.snap$|\.generated\.|(^|\/)(dist|generated)\/)/;

// HunkRef.fileRole when the pipeline sets it, else a guess from the path.
export const hunkRole = (h) => h.fileRole || (TEST_RE.test(h.path) ? "test" : DOC_RE.test(h.path) ? "docs" : GENERATED_RE.test(h.path) ? "generated" : CONFIG_RE.test(h.path) ? "config" : "source");

const hunkExtraKind = (h) => {
  const r = hunkRole(h);
  return r === "test" ? "test" : r === "docs" ? "doc" : null;
};

export function prepareStory(story) {
  if (!story || story.extras) return story;
  const allExtra = story.steps.length && story.steps.every((s) => s.hunks.every((h) => hunkExtraKind(h)));
  if (allExtra) return { ...story, extras: [] };
  const byPath = new Map();
  const steps = [];
  for (const step of story.steps) {
    const main = [];
    for (const h of step.hunks) {
      const kind = hunkExtraKind(h);
      if (!kind) {
        main.push(h);
        continue;
      }
      if (!byPath.has(h.path)) byPath.set(h.path, { path: h.path, kind, hunks: [], origin: { id: step.id, title: step.title } });
      byPath.get(h.path).hunks.push(h);
    }
    if (main.length || !step.hunks.length) steps.push({ ...step, hunks: main });
  }
  const kept = new Set(steps.map((s) => s.id));
  steps.forEach((s, i) => {
    s.order = i + 1;
    s.dependsOn = (s.dependsOn || []).filter((id) => kept.has(id));
  });
  const idx = (h) => Number(String(h.id).split("#").pop()) || 0;
  const extras = [...byPath.values()]
    .map((f) => {
      f.hunks.sort((a, b) => idx(a) - idx(b));
      const notes = [...new Set(f.hunks.map((h) => h.note).filter(Boolean))];
      return { ...f, notes };
    })
    .sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === "test" ? -1 : 1));
  return { ...story, steps, extras };
}

export function nodeTarget(step, node) {
  return step ? diagramTarget(step.hunks, node) : null;
}
