import { prepareStory } from "./prepare.js";

const PR_RE = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i;

export function parsePrUrl(input) {
  const m = PR_RE.exec((input || "").trim());
  return m ? { owner: m[1], repo: m[2], number: +m[3], key: `${m[1]}/${m[2]}#${m[3]}`.toLowerCase() } : null;
}

export async function fetchPipelineIndex() {
  try {
    const r = await fetch("/pipeline/index.json");
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

// Returns { name } for a known PR, { error: "invalid" } for text that is not a PR URL, { error: "unknown", parsed } otherwise.
export async function resolvePr(input) {
  const parsed = parsePrUrl(input);
  if (!parsed) return { error: "invalid" };
  const idx = await fetchPipelineIndex();
  const hit = idx.find((p) => p.url && parsePrUrl(p.url)?.key === parsed.key);
  if (hit) return { name: hit.name };
  return { error: "unknown", parsed };
}

async function getJson(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// spec: a name ("devops-monorepo-2203"), a pipeline name, or an http(s) / absolute-path URL to a PRStory JSON.
export async function loadStory(spec) {
  const isUrl = /^(https?:)?\/\//.test(spec) || spec.startsWith("/");
  const name = isUrl ? spec.split("/").pop().replace(/\.json$/, "") : spec;
  const story = isUrl ? await getJson(spec) : (await getJson(`/stories/${spec}.json`)) || (await getJson(`/pipeline/${spec}.json`));
  if (!story || ![1, 2].includes(story.schemaVersion)) return null;
  return { name, story: prepareStory(story), spec };
}

export async function refetchStory(spec) {
  const isUrl = /^(https?:)?\/\//.test(spec) || spec.startsWith("/");
  const story = isUrl ? await getJson(spec) : (await getJson(`/stories/${spec}.json`)) || (await getJson(`/pipeline/${spec}.json`));
  return prepareStory(story);
}
