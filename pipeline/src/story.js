import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function prMeta(meta) {
  const repo = meta.url.match(/github\.com\/([^/]+\/[^/]+)\/pull/)[1];
  return {
    repo,
    number: meta.number,
    title: meta.title,
    url: meta.url,
    author: meta.author?.login || meta.author,
    baseRef: meta.baseRefName,
    headRef: meta.headRefName,
    headSha: meta.headRefOid,
    additions: meta.additions,
    deletions: meta.deletions,
    changedFiles: meta.changedFiles,
  };
}

export function hunkRef(h, note) {
  const ref = { id: h.id, fingerprint: h.fingerprint, path: h.path, fileRole: h.fileRole || 'source' };
  if (h.oldPath) ref.oldPath = h.oldPath;
  Object.assign(ref, { fileStatus: h.fileStatus, oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, header: h.header, patch: h.patch });
  if (note) ref.note = note;
  return ref;
}

export const MAX_STEPS = 10;

export function enforceCoverage(planSteps, hunks) {
  const known = new Set(hunks.map((h) => h.alias));
  const owner = new Map();
  const issues = { unknown: [], duplicated: [], missing: [], emptySteps: 0 };
  planSteps.forEach((s, si) => {
    const mine = [];
    for (const a of s.hunkAliases) {
      if (!known.has(a)) { issues.unknown.push(a); continue; }
      if (owner.has(a)) { if (owner.get(a) !== si) issues.duplicated.push(a); continue; }
      owner.set(a, si);
      mine.push(a);
    }
    s.hunkAliases = mine;
  });
  for (const h of hunks) {
    if (owner.has(h.alias)) continue;
    issues.missing.push(h.alias);
    const sameFile = hunks.filter((x) => x.path === h.path && owner.has(x.alias));
    let target = sameFile.length ? owner.get(sameFile[0].alias) : -1;
    if (target < 0) {
      const dir = h.path.split('/').slice(0, -1).join('/');
      const sameDir = hunks.find((x) => owner.has(x.alias) && x.path.startsWith(dir + '/'));
      if (sameDir) target = owner.get(sameDir.alias);
    }
    if (target < 0) {
      let other = planSteps.findIndex((s) => s.isLeftovers);
      if (other < 0 && planSteps.filter((s) => s.hunkAliases.length).length >= MAX_STEPS) other = planSteps.findLastIndex((s) => s.hunkAliases.length);
      if (other < 0) {
        planSteps.push({ title: 'Other changes', kind: 'refactor', summary: 'Hunks the planner did not place in a step.', dependsOn: [], hunkAliases: [], isLeftovers: true });
        other = planSteps.length - 1;
      }
      target = other;
    }
    planSteps[target].hunkAliases.push(h.alias);
    owner.set(h.alias, target);
  }
  const before = planSteps.length;
  const kept = planSteps.filter((s) => s.hunkAliases.length);
  issues.emptySteps = before - kept.length;
  const order = new Map(hunks.map((h, i) => [h.alias, i]));
  for (const s of kept) s.hunkAliases.sort((a, b) => order.get(a) - order.get(b));
  return { steps: kept, issues };
}

const sharedDir = (a, b) => {
  const pa = a.split('/');
  const pb = b.split('/');
  let i = 0;
  while (i < pa.length - 1 && i < pb.length - 1 && pa[i] === pb[i]) i++;
  return i;
};

export function mergeSmallSteps(steps, { sizeOf, pathOf, orderOf, minLines = 20, minSteps = 1, maxSteps = Infinity }) {
  const list = [...steps];
  const merge = (index) => {
    const step = list[index];
    let best = -1;
    let bestScore = -1;
    list.forEach((o, i) => {
      if (o === step) return;
      const score = Math.max(0, ...o.hunkAliases.map((x) => Math.max(...step.hunkAliases.map((y) => sharedDir(pathOf(y), pathOf(x))))));
      if (score > bestScore || (score === bestScore && best >= 0 && sizeOf(o) > sizeOf(list[best]))) {
        best = i;
        bestScore = score;
      }
    });
    const target = list[best];
    target.hunkAliases = [...target.hunkAliases, ...step.hunkAliases].sort((a, b) => orderOf(a) - orderOf(b));
    list.splice(index, 1);
  };
  const smallest = () => list.reduce((best, s, i) => (best < 0 || sizeOf(s) < sizeOf(list[best]) ? i : best), -1);
  while (list.length > maxSteps && list.length > 1) merge(smallest());
  for (let i = list.findIndex((s) => sizeOf(s) < minLines); i >= 0 && list.length > minSteps; i = list.findIndex((s) => sizeOf(s) < minLines)) merge(i);
  return list;
}

export function validateCoverage(story, hunks) {
  const seen = new Map();
  for (const s of story.steps) for (const h of s.hunks) seen.set(h.id, (seen.get(h.id) || 0) + 1);
  const missing = hunks.filter((h) => !seen.has(h.id)).map((h) => h.id);
  const dup = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  const extra = [...seen.keys()].filter((id) => !hunks.some((h) => h.id === id));
  return { ok: !missing.length && !dup.length && !extra.length, missing, dup, extra };
}

export function buildSteps(planSteps, hunks) {
  const byAlias = new Map(hunks.map((h) => [h.alias, h]));
  return planSteps.map((s, i) => ({
    id: 's' + (i + 1),
    order: i + 1,
    status: 'pending',
    title: s.title,
    kind: s.kind,
    summary: s.summary,
    dependsOn: [],
    hunks: s.hunkAliases.map((a) => hunkRef(byAlias.get(a))),
    _aliases: s.hunkAliases,
    _dependsOnRaw: s.dependsOn || [],
  }));
}

export function resolveDependsOn(steps) {
  for (const s of steps) {
    const deps = new Set();
    for (const d of s._dependsOnRaw) {
      const n = typeof d === 'number' ? d : parseInt(String(d).replace(/\D/g, ''), 10);
      if (n >= 1 && n < s.order) deps.add('s' + n);
    }
    s.dependsOn = [...deps];
  }
}

const KINDS = ['contract', 'core-logic', 'wiring', 'ui', 'tests', 'config', 'refactor', 'docs'];
export function normalizeKind(k) {
  return KINDS.includes(k) ? k : 'refactor';
}

const words = (s) => String(s).trim().split(/\s+/).filter(Boolean);

export function shortNote(text, maxWords = 15) {
  const w = words(text);
  return w.length > maxWords ? w.slice(0, maxWords).join(' ') : w.join(' ');
}

export function splitColon(text) {
  return String(text || '')
    .split(/(`[^`]*`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/([a-z0-9)\]])\s*:\s+([a-z])/g, (m, before, after) => before + '. ' + after.toUpperCase())
            .replace(/^:\s+([a-z])/, (m, after) => '. ' + after.toUpperCase())
    )
    .join('');
}

const DIAGRAM_KINDS = new Set(['step', 'decision', 'end']);
const DIAGRAM_CHANGES = new Set(['added', 'modified', 'removed', 'unchanged']);
const MAX_DIAGRAM_WORDS = 8;
const MIN_DIAGRAM_NODES = 3;
const MAX_DIAGRAM_NODES = 6;
const MAX_DIAGRAM_LAYERS = 4;

function labelProblems(label) {
  const text = typeof label === 'string' ? label.trim() : '';
  return text ? [] : ['no label'];
}

const looksLikeCode = (text) => /[`/_]|[a-z][A-Z]/.test(text);

const STOP_WORDS = new Set(('a an the this that these those it its they them their there here ' +
  'and or but if then than so because while when where which who whom whose as of to in on at by for with from into onto over under ' +
  'is are was were be been being am do does did done has have had can could may might must will would shall should ' +
  'not no yes also just only any all some each every other same such more most less least very too again still yet ' +
  'we you he she i me my our your his her one two').split(' '));

function contentWords(text) {
  return (String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => !STOP_WORDS.has(w));
}

function branchProblems(d, branches) {
  const out = [];
  const outcomes = new Set();
  for (const b of branches) for (const w of contentWords(b && b.outcome)) outcomes.add(w);
  for (const n of d.nodes) {
    if (!n || n.kind !== 'end') continue;
    if (!contentWords(n.label).some((w) => outcomes.has(w))) out.push('end node "' + n.label + '" shares no word with any branch outcome');
  }
  return out;
}

// Columns the way the UI lays them out: back edges are the edges that reach a
// node still open on the DFS stack, and a column is the longest path from a
// source over the forward edges only.
export function diagramColumns(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outs = new Map(nodes.map((n) => [n.id, []]));
  const ins = new Map(nodes.map((n) => [n.id, []]));
  const linked = (e) => byId.has(e.from) && byId.has(e.to);
  edges.forEach((e, i) => {
    if (!linked(e)) return;
    outs.get(e.from).push(i);
    ins.get(e.to).push(i);
  });
  const back = new Set();
  const seen = new Map();
  const walk = (root) => {
    const stack = [[root, 0]];
    seen.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const list = outs.get(top[0]);
      if (top[1] >= list.length) {
        seen.set(top[0], 2);
        stack.pop();
        continue;
      }
      const ei = list[top[1]];
      top[1]++;
      const to = edges[ei].to;
      if (to === top[0]) {
        back.add(ei);
        continue;
      }
      if (seen.get(to) === 1) back.add(ei);
      else if (!seen.get(to)) {
        seen.set(to, 1);
        stack.push([to, 0]);
      }
    }
  };
  const roots = nodes.filter((n) => !ins.get(n.id).length).map((n) => n.id);
  const order = [...new Set([nodes[0]?.id, ...roots, ...nodes.map((n) => n.id)])].filter((id) => id && byId.has(id));
  for (const id of order) if (!seen.get(id)) walk(id);

  const want = new Map(nodes.map((n) => [n.id, 0]));
  edges.forEach((e, i) => {
    if (linked(e) && !back.has(i)) want.set(e.to, want.get(e.to) + 1);
  });
  const colOf = new Map(nodes.map((n) => [n.id, 0]));
  const queue = nodes.filter((n) => !want.get(n.id)).map((n) => n.id);
  for (let qi = 0; qi < queue.length; qi++) {
    const id = queue[qi];
    outs.get(id).forEach((ei) => {
      if (back.has(ei)) return;
      const to = edges[ei].to;
      colOf.set(to, Math.max(colOf.get(to), colOf.get(id) + 1));
      want.set(to, want.get(to) - 1);
      if (!want.get(to)) queue.push(to);
    });
  }
  return { byId, outs, back, colOf };
}

function skippedNode(shape, edge, edges) {
  const layer = shape.colOf.get(edge.from) + 1;
  const rev = new Map([...shape.byId.keys()].map((id) => [id, []]));
  edges.forEach((e, i) => {
    if (shape.back.has(i) || !shape.byId.has(e.from) || !shape.byId.has(e.to)) return;
    rev.get(e.to).push(e.from);
  });
  const reach = new Set([edge.from]);
  const fq = [edge.from];
  while (fq.length) {
    const id = fq.pop();
    for (const ei of shape.outs.get(id)) {
      if (shape.back.has(ei)) continue;
      const to = edges[ei].to;
      if (!reach.has(to)) {
        reach.add(to);
        fq.push(to);
      }
    }
  }
  const from = new Set([edge.to]);
  const bq = [edge.to];
  while (bq.length) {
    const id = bq.pop();
    for (const prev of rev.get(id) || []) {
      if (!from.has(prev)) {
        from.add(prev);
        bq.push(prev);
      }
    }
  }
  const at = [...shape.byId.keys()].filter((id) => shape.colOf.get(id) === layer);
  const onPath = at.filter((id) => reach.has(id) && from.has(id));
  const id = onPath[0] ?? at[0];
  return id ? shape.byId.get(id).label : null;
}

function skipEdgeProblems(shape, edges) {
  const out = [];
  edges.forEach((e, i) => {
    if (shape.back.has(i)) return;
    const a = shape.colOf.get(e.from);
    const b = shape.colOf.get(e.to);
    if (b === a + 1) return;
    const node = shape.byId.get(e.from);
    const skipped = skippedNode(shape, e, edges);
    const actor = (node.kind === 'decision' ? 'Decision "' : 'Edge "') + node.label + '"' + (e.label ? ' branch "' + e.label + '"' : '');
    out.push(actor + ' ' + (skipped ? 'skips over "' + skipped + '"' : 'skips a column') + ' (column ' + a + ' to ' + b + ')');
  });
  return out;
}

function sharedTargetProblems(nodes, edges) {
  const out = [];
  const targets = new Map();
  for (const e of edges) {
    if (!targets.has(e.from)) targets.set(e.from, new Set());
    targets.get(e.from).add(e.to);
  }
  for (const n of nodes) {
    if (n.kind !== 'decision') continue;
    const n2 = (targets.get(n.id) || new Set()).size;
    if (n2 < 2) out.push('Decision "' + n.label + '" leads to ' + n2 + ' target' + (n2 === 1 ? '' : 's') + ', needs 2 different nodes');
  }
  return out;
}

const REPEAT_WORD = /retry|retries|again|repeat|re-?plan|re-?run|re-?try|until|loop|cap|next/i;

function loopProblems(shape, edges) {
  const out = [];
  edges.forEach((e, i) => {
    if (!shape.back.has(i)) return;
    const to = shape.byId.get(e.to);
    if (REPEAT_WORD.test((e.label || '') + ' ' + (to ? to.label : ''))) return;
    out.push('Edge "' + (e.label || 'unlabelled') + '" loops back to "' + (to ? to.label : e.to) + '" but nothing says the work repeats. Write the case as its own node');
  });
  return out;
}

export function diagramShapeProblems(d) {
  if (!d || !Array.isArray(d.nodes) || !Array.isArray(d.edges)) return [];
  const nodes = d.nodes.filter((n) => n && typeof n.id === 'string' && n.id);
  const ids = new Set(nodes.map((n) => n.id));
  const typedEdges = d.edges.filter((e) => e && typeof e.from === 'string' && typeof e.to === 'string');
  const edges = typedEdges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const invalid = typedEdges.filter((e) => !ids.has(e.from) || !ids.has(e.to)).map(() => 'edge to an unknown node');
  const shape = diagramColumns(nodes, edges);
  return [...invalid, ...sharedTargetProblems(nodes, edges), ...skipEdgeProblems(shape, edges), ...loopProblems(shape, edges)];
}

export function diagramProblems(d, branches = null) {
  if (!d || !Array.isArray(d.nodes) || !Array.isArray(d.edges)) return ['missing nodes or edges'];
  const out = [];
  if (d.nodes.length < MIN_DIAGRAM_NODES || d.nodes.length > MAX_DIAGRAM_NODES) out.push(d.nodes.length + ' nodes, expected ' + MIN_DIAGRAM_NODES + '-' + MAX_DIAGRAM_NODES);
  const columns = new Set(d.nodes.map((n) => n && n.layer).filter((l) => Number.isInteger(l) && l >= 0));
  if (columns.size > MAX_DIAGRAM_LAYERS) out.push(columns.size + ' columns, max ' + MAX_DIAGRAM_LAYERS);
  const ids = new Set();
  for (const n of d.nodes) {
    if (!n || typeof n.id !== 'string' || !n.id) { out.push('node without id'); continue; }
    if (ids.has(n.id)) out.push('duplicate node id ' + n.id);
    ids.add(n.id);
    if (!DIAGRAM_KINDS.has(n.kind)) out.push('node ' + n.id + ' has kind ' + JSON.stringify(n.kind));
    if (!DIAGRAM_CHANGES.has(n.change)) out.push('node ' + n.id + ' has change ' + JSON.stringify(n.change));
    if (!Number.isInteger(n.layer) || n.layer < 0) out.push('node ' + n.id + ' has no layer');
    for (const p of labelProblems(n.label)) out.push('node ' + n.id + ' ' + p);
  }
  if (!d.nodes.some((n) => n && n.kind === 'decision')) out.push('no decision node');
  for (const e of d.edges) {
    if (!e || !ids.has(e.from) || !ids.has(e.to)) { out.push('edge to an unknown node'); continue; }
    for (const p of labelProblems(e.label)) if (p !== 'no label') out.push('edge ' + e.from + '>' + e.to + ' ' + p);
    if (e.kind !== undefined) out.push('edge ' + e.from + '>' + e.to + ' has an edge kind');
  }
  out.push(...diagramShapeProblems(d));
  if (Array.isArray(branches)) {
    if (!branches.length) out.push('a diagram needs at least one branch');
    else out.push(...branchProblems(d, branches));
  }
  return out;
}

export function cleanDiagram(d, branches = null) {
  if (!d) return undefined;
  const problems = diagramProblems(d, branches);
  if (problems.length) {
    console.error('[pr-explainer] diagram dropped: ' + problems.join('; '));
    return undefined;
  }
  const layers = [...new Set(d.nodes.map((n) => n.layer))].sort((a, b) => a - b);
  const layerIndex = new Map(layers.map((l, i) => [l, i]));
  const trim = (text) => words(text).slice(0, MAX_DIAGRAM_WORDS).join(' ');
  const codeLike = [...d.nodes, ...d.edges].map((x) => x.label).filter((l) => typeof l === 'string' && looksLikeCode(l));
  if (codeLike.length) console.error('[pr-explainer] diagram kept, label looks like code: ' + codeLike.map((l) => '"' + l + '"').join(', '));
  const nodes = d.nodes.map((n) => {
    const node = { id: n.id, label: trim(n.label), kind: n.kind, change: n.change, layer: layerIndex.get(n.layer) };
    if (n.path) node.path = n.path;
    return node;
  });
  const seen = new Set();
  const edges = [];
  for (const e of d.edges) {
    if (seen.has(e.from + '>' + e.to)) continue;
    seen.add(e.from + '>' + e.to);
    const edge = { from: e.from, to: e.to };
    if (e.label) edge.label = trim(e.label);
    edges.push(edge);
  }
  const out = { nodes, edges };
  if (d.title) out.title = d.title;
  return out;
}

export function publicStory(story) {
  return JSON.parse(JSON.stringify(story, (k, v) => (k.startsWith('_') ? undefined : v)));
}

export function writeStory(path, story) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(publicStory(story), null, 2));
  renameSync(tmp, path);
}
