// Simulated streaming: the full story is revealed over time, as a pipeline would write it.
export function makeTimeline(story) {
  const n = story.steps.length;
  const first = 3300;
  const last = 10400;
  const ready = story.steps.map((_, i) => Math.round(first + (n > 1 ? (i * (last - first)) / (n - 1) : 0) + (((i * 37) % 5) - 2) * 140));
  return { planAt: 700, summaryAt: 1500, ready, doneAt: ready[n - 1] + 350 };
}

const stripStep = (s) => ({ ...s, status: "pending", gist: undefined, explanation: undefined, dataFlow: undefined, diagram: undefined, checklist: undefined });

export function partialStory(story, ms, tl) {
  if (ms >= tl.doneAt) return story;
  const status = ms < tl.planAt ? "queued" : ms < tl.summaryAt ? "planning" : "explaining";
  const out = { ...story, generation: { ...story.generation, status, finishedAt: undefined, timings: undefined }, summary: undefined, steps: [], skippedFiles: [] };
  if (ms >= tl.summaryAt) {
    out.summary = story.summary;
    out.skippedFiles = story.skippedFiles;
    out.steps = story.steps.map((s, i) => (ms >= tl.ready[i] ? s : stripStep(s)));
  }
  return out;
}

export const isGenerating = (story) => !["done", "failed"].includes(story.generation.status);

const SEEN_KEY = "prx.seen";
const SEED = [];
export function hasSeen(name) {
  try {
    const list = JSON.parse(localStorage.getItem(SEEN_KEY) || "null") || SEED;
    return list.includes(name);
  } catch {
    return false;
  }
}
export function markSeen(name) {
  try {
    const list = JSON.parse(localStorage.getItem(SEEN_KEY) || "null") || SEED.slice();
    if (!list.includes(name)) list.push(name);
    localStorage.setItem(SEEN_KEY, JSON.stringify(list));
  } catch {}
}
