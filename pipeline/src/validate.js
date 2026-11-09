import { createHash } from 'node:crypto';

import { diagramProblems } from './story.js';

const F = {
  story: ['schemaVersion', 'pr', 'generation', 'summary', 'steps', 'skippedFiles'],
  pr: ['repo', 'number', 'title', 'body', 'url', 'author', 'baseRef', 'headRef', 'baseSha', 'headSha', 'additions', 'deletions', 'changedFiles'],
  generation: ['status', 'pipelineVersion', 'model', 'startedAt', 'finishedAt', 'timings', 'error', 'summaryFallback'],
  timings: ['summaryMs', 'planMs', 'step1Ms', 'totalMs'],
  summary: ['why', 'whatChanged', 'risk', 'riskReason', 'reviewMinutes'],
  step: ['id', 'order', 'status', 'title', 'kind', 'summary', 'dependsOn', 'hunks', 'gist', 'diagram', 'error', 'changedInSha'],
  hunk: ['id', 'fingerprint', 'path', 'oldPath', 'fileStatus', 'fileRole', 'oldStart', 'oldLines', 'newStart', 'newLines', 'header', 'patch', 'note'],
  diagram: ['title', 'nodes', 'edges'],
  node: ['id', 'label', 'kind', 'change', 'layer', 'path'],
  edge: ['from', 'to', 'label'],
  skipped: ['path', 'reason'],
};

const STATUS = ['queued', 'planning', 'explaining', 'done', 'failed'];
const STEP_STATUS = ['pending', 'ready', 'failed'];
const KINDS = ['contract', 'core-logic', 'wiring', 'ui', 'tests', 'config', 'refactor', 'docs'];
const FILE_STATUS = ['added', 'modified', 'removed', 'renamed'];
const FILE_ROLE = ['source', 'test', 'generated', 'docs', 'config'];
const RISK = ['low', 'medium', 'high'];
const SKIP_REASON = ['lockfile', 'generated', 'snapshot', 'binary', 'too-large', 'empty', 'other'];
const MAX_STEPS = 10;
const MAX_CHANGED_WORDS = 12;
const MAX_SUMMARY_WORDS = 40;
const MAX_GIST_WORDS = 55;
const MAX_GIST_SENTENCES = 3;
const MIN_GIST_SENTENCES = 2;
const SHORT_STEP_LINES = 30;
const AI_WORDS = [
  'additionally', 'crucial', 'delve', 'enhance', 'enhances', 'pivotal', 'robust', 'seamless', 'showcase',
  'underscore', 'leverage', 'utilize', 'facilitate', 'streamline', 'comprehensive', 'landscape', 'tapestry',
  'testament', 'ensure', 'ensures', 'ensuring',
];

const wordCount = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isInt = (v) => Number.isInteger(v);
const hex = (v, n) => isStr(v) && v.length === n && /^[0-9a-f]+$/.test(v);

const stripCode = (s) =>
  String(s)
    .replace(/`[^`]*`/g, '')
    .replace(/\*\*/g, '');
const codeNames = (s) => String(s).match(/`[^`]+`/g) || [];
const boldPhrases = (s) => String(s).match(/\*\*[^*\n]+\*\*/g) || [];

function sentenceCount(text) {
  return (stripCode(text).match(/[^.!?]+[.!?]*/g) || []).filter((s) => /\S/.test(s)).length;
}

export function hunkChangedLines(hunk) {
  return String(hunk?.patch || '')
    .split('\n')
    .slice(1)
    .filter((l) => l.startsWith('+') || l.startsWith('-')).length;
}

export function stepChangedLines(step) {
  return (step?.hunks || []).reduce((n, h) => n + hunkChangedLines(h), 0);
}

export function gistLint(gist, { changedLines = null } = {}) {
  const v = [];
  const text = String(gist || '').trim();
  if (!text) return ['empty gist'];
  const words = wordCount(text);
  if (words > MAX_GIST_WORDS) v.push(words + ' words, max ' + MAX_GIST_WORDS);
  const sentences = sentenceCount(text);
  if (sentences > MAX_GIST_SENTENCES) v.push(sentences + ' sentences, max ' + MAX_GIST_SENTENCES);
  const min = changedLines !== null && changedLines < SHORT_STEP_LINES ? 1 : MIN_GIST_SENTENCES;
  if (sentences < min) v.push(sentences + ' sentences, min ' + min);
  if (/\u2014/.test(text)) v.push('em dash');

  const plain = stripCode(text);
  const opener = plain.match(/^[*_\s]*[^.!?\n]{1,40}:\s/);
  if (opener) v.push('label-style opener');
  if (/:\s/.test(opener ? plain.slice(opener[0].length) : plain)) v.push('colon followed by a space');
  if (/->|\u2192|=>/.test(plain)) v.push('arrow outside backticks');
  if (text.includes('?')) v.push('question mark');
  const names = codeNames(text);
  if (names.length > 1) v.push(names.length + ' backticked names, max 1');
  const bold = boldPhrases(text);
  if (bold.length > 1) v.push(bold.length + ' bold phrases, max 1');
  const lower = text.toLowerCase();
  if (/\bsteps?\b|\b(earlier|previous|later|next) (part|work|change)s?\b/.test(lower)) v.push('refers to another step');
  if (/\balready\b/.test(lower)) v.push('restates what already exists');
  for (const w of AI_WORDS) if (new RegExp('\\b' + w + '\\b').test(lower)) v.push('AI word "' + w + '"');
  return v;
}

export function validateStory(story, hunks = null) {
  const v = [];
  const bad = (path, msg) => v.push(path + ': ' + msg);
  const warn = (path, msg) => v.push('warning: ' + path + ': ' + msg);

  function keys(obj, allowed, path) {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) bad(path + '.' + k, 'unknown field');
  }

  function str(obj, key, path, { required = true, empty = false } = {}) {
    const val = obj[key];
    if (val === undefined) {
      if (required) bad(path + '.' + key, 'missing');
      return false;
    }
    if (!isStr(val)) return bad(path + '.' + key, 'expected string'), false;
    if (!empty && !val.length) return bad(path + '.' + key, 'empty string'), false;
    return true;
  }

  function strArr(obj, key, path, { required = true, max = null } = {}) {
    const val = obj[key];
    if (val === undefined) {
      if (required) bad(path + '.' + key, 'missing');
      return;
    }
    if (!Array.isArray(val)) return bad(path + '.' + key, 'expected array');
    if (max !== null && val.length > max) bad(path + '.' + key, val.length + ' items, max ' + max);
    val.forEach((x, i) => {
      if (!isStr(x)) bad(path + '.' + key + '[' + i + ']', 'expected string');
    });
  }

  function enumOf(obj, key, allowed, path, { required = true } = {}) {
    const val = obj[key];
    if (val === undefined) {
      if (required) bad(path + '.' + key, 'missing');
      return;
    }
    if (!allowed.includes(val)) bad(path + '.' + key, 'expected one of ' + allowed.join('|') + ', got ' + JSON.stringify(val));
  }

  function diagram(d, path) {
    if (!isObj(d)) return bad(path, 'expected object');
    keys(d, F.diagram, path);
    if (d.title !== undefined) str(d, 'title', path);
    const nodes = Array.isArray(d.nodes) ? d.nodes : [];
    const edges = Array.isArray(d.edges) ? d.edges : [];
    nodes.forEach((n, i) => {
      const p = path + '.nodes[' + i + ']';
      if (!isObj(n)) return bad(p, 'expected object');
      keys(n, F.node, p);
      if (n.path !== undefined) str(n, 'path', p);
    });
    edges.forEach((e, i) => {
      const p = path + '.edges[' + i + ']';
      if (!isObj(e)) return bad(p, 'expected object');
      keys(e, F.edge, p);
    });
    for (const p of diagramProblems({ nodes, edges })) bad(path, p);
  }

  if (!isObj(story)) return ['story: expected object'];
  keys(story, F.story, 'story');
  if (story.schemaVersion !== 2) bad('story.schemaVersion', 'expected 2, got ' + JSON.stringify(story.schemaVersion));

  if (!isObj(story.pr)) bad('story.pr', 'missing');
  else {
    const pr = story.pr;
    keys(pr, F.pr, 'pr');
    if (str(pr, 'repo', 'pr') && !/^[^/\s]+\/[^/\s]+$/.test(pr.repo)) bad('pr.repo', 'expected "owner/name"');
    if (!isInt(pr.number) || pr.number <= 0) bad('pr.number', 'expected positive integer');
    str(pr, 'title', 'pr');
    str(pr, 'body', 'pr', { empty: true });
    if (str(pr, 'url', 'pr') && !pr.url.startsWith('https://github.com/')) bad('pr.url', 'expected github url');
    str(pr, 'author', 'pr');
    for (const k of ['baseRef', 'headRef']) str(pr, k, 'pr');
    for (const k of ['baseSha', 'headSha']) if (str(pr, k, 'pr') && !hex(pr[k], 40)) bad('pr.' + k, 'expected 40 hex chars');
    for (const k of ['additions', 'deletions']) if (!isInt(pr[k]) || pr[k] < 0) bad('pr.' + k, 'expected integer >= 0');
    if (!isInt(pr.changedFiles) || pr.changedFiles < 0) bad('pr.changedFiles', 'expected integer >= 0');
  }

  const gen = story.generation;
  if (!isObj(gen)) bad('story.generation', 'missing');
  else {
    keys(gen, F.generation, 'generation');
    enumOf(gen, 'status', STATUS, 'generation');
    if (str(gen, 'pipelineVersion', 'generation') && !hex(gen.pipelineVersion, 12)) bad('generation.pipelineVersion', 'expected 12 hex chars');
    str(gen, 'model', 'generation');
    if (str(gen, 'startedAt', 'generation') && Number.isNaN(Date.parse(gen.startedAt))) bad('generation.startedAt', 'expected ISO date');
    if (gen.finishedAt !== undefined && (!isStr(gen.finishedAt) || Number.isNaN(Date.parse(gen.finishedAt)))) bad('generation.finishedAt', 'expected ISO date');
    if (gen.timings !== undefined) {
      if (!isObj(gen.timings)) bad('generation.timings', 'expected object');
      else {
        keys(gen.timings, F.timings, 'generation.timings');
        for (const k of F.timings) if (gen.timings[k] !== undefined && (!isInt(gen.timings[k]) || gen.timings[k] < 0)) bad('generation.timings.' + k, 'expected integer >= 0');
      }
    }
    if (gen.status === 'failed' && !isStr(gen.error)) bad('generation.error', 'missing on failed generation');
    if (gen.error !== undefined) str(gen, 'error', 'generation');
    if (gen.summaryFallback !== undefined && typeof gen.summaryFallback !== 'boolean') bad('generation.summaryFallback', 'expected boolean');
  }

  if (story.summary !== undefined) {
    const s = story.summary;
    if (!isObj(s)) bad('story.summary', 'expected object');
    else {
      keys(s, F.summary, 'summary');
      str(s, 'why', 'summary');
      strArr(s, 'whatChanged', 'summary');
      if (Array.isArray(s.whatChanged)) {
        if (s.whatChanged.length > 5) bad('summary.whatChanged', s.whatChanged.length + ' bullets, max 5');
        s.whatChanged.forEach((b, i) => {
          if (isStr(b) && wordCount(b) > MAX_CHANGED_WORDS) bad('summary.whatChanged[' + i + ']', wordCount(b) + ' words, max ' + MAX_CHANGED_WORDS);
        });
      }
      enumOf(s, 'risk', RISK, 'summary');
      str(s, 'riskReason', 'summary');
      if (!isInt(s.reviewMinutes) || s.reviewMinutes < 0) bad('summary.reviewMinutes', 'expected integer >= 0');
    }
  }
  if (story.generation?.status === 'done' && !isObj(story.summary)) bad('story.summary', 'missing on a done generation');

  if (!Array.isArray(story.skippedFiles)) bad('story.skippedFiles', 'expected array');
  else {
    story.skippedFiles.forEach((f, i) => {
      const p = 'skippedFiles[' + i + ']';
      if (!isObj(f)) return bad(p, 'expected object');
      keys(f, F.skipped, p);
      str(f, 'path', p);
      enumOf(f, 'reason', SKIP_REASON, p);
    });
  }
  if (!Array.isArray(story.steps)) bad('story.steps', 'expected array');
  else {
    if (!story.steps.length) bad('story.steps', 'empty');
    if (story.steps.length > MAX_STEPS) bad('story.steps', story.steps.length + ' steps, max ' + MAX_STEPS);
    const stepIds = new Set();
    story.steps.forEach((s, i) => {
      if (isObj(s) && isStr(s.id)) stepIds.add(s.id);
      const p = 'steps[' + i + ']';
      if (!isObj(s)) return bad(p, 'expected object');
      keys(s, F.step, p);
      if (str(s, 'id', p) && s.id !== 's' + (i + 1)) bad(p + '.id', 'expected "s' + (i + 1) + '", got ' + s.id);
      if (s.order !== i + 1) bad(p + '.order', 'expected ' + (i + 1) + ', got ' + JSON.stringify(s.order));
      enumOf(s, 'status', STEP_STATUS, p);
      str(s, 'title', p);
      enumOf(s, 'kind', KINDS, p);
      str(s, 'summary', p);
      if (isStr(s.summary)) {
        const sentences = (s.summary.match(/[.!?](\s|$)/g) || []).length;
        if (sentences > 2) bad(p + '.summary', sentences + ' sentences, max 2');
        if (wordCount(s.summary) > MAX_SUMMARY_WORDS) bad(p + '.summary', wordCount(s.summary) + ' words, max ' + MAX_SUMMARY_WORDS);
      }
      if (!Array.isArray(s.dependsOn)) bad(p + '.dependsOn', 'expected array');
      else
        s.dependsOn.forEach((d, k) => {
          if (!isStr(d) || !/^s\d+$/.test(d)) return bad(p + '.dependsOn[' + k + ']', 'expected a step id');
          const n = Number(d.slice(1));
          if (n < 1 || n >= i + 1) bad(p + '.dependsOn[' + k + ']', 'must point to an earlier step, got ' + d);
        });
      if (!Array.isArray(s.hunks) || !s.hunks.length) bad(p + '.hunks', 'expected a non-empty array');
      else
        s.hunks.forEach((h, k) => {
          const hp = p + '.hunks[' + k + ']';
          if (!isObj(h)) return bad(hp, 'expected object');
          keys(h, F.hunk, hp);
          if (str(h, 'id', hp) && !/^.+\#\d+$/.test(h.id)) bad(hp + '.id', 'expected "<path>#<index>"');
          if (str(h, 'fingerprint', hp)) {
            if (!hex(h.fingerprint, 16)) bad(hp + '.fingerprint', 'expected 16 hex chars');
            else if (isStr(h.path) && isStr(h.patch) && h.fingerprint !== fingerprintOf(h.path, h.patch)) bad(hp + '.fingerprint', 'does not match path + changed lines');
          }
          str(h, 'path', hp);
          if (h.oldPath !== undefined) str(h, 'oldPath', hp);
          enumOf(h, 'fileStatus', FILE_STATUS, hp);
          enumOf(h, 'fileRole', FILE_ROLE, hp);
          if (h.fileStatus === 'renamed' && !isStr(h.oldPath)) bad(hp + '.oldPath', 'required for a renamed file');
          for (const k2 of ['oldStart', 'oldLines', 'newStart', 'newLines']) if (!isInt(h[k2]) || h[k2] < 0) bad(hp + '.' + k2, 'expected integer >= 0');
          if (str(h, 'header', hp, { empty: true }) && h.header.includes('@@')) bad(hp + '.header', 'must not repeat the @@ line');
          if (str(h, 'patch', hp) && !h.patch.startsWith('@@')) bad(hp + '.patch', 'must start with the @@ line');
          if (h.note !== undefined) str(h, 'note', hp);
        });
      if (s.status === 'ready' && !isStr(s.gist)) bad(p + '.gist', 'missing on a ready step');
      if (s.gist !== undefined) str(s, 'gist', p);
      if (isStr(s.gist)) for (const w of gistLint(s.gist, { changedLines: stepChangedLines(s) })) warn(p + '.gist', w);
      if (s.diagram !== undefined && s.diagram !== null) diagram(s.diagram, p + '.diagram');
      if (s.status === 'failed' && !isStr(s.error)) bad(p + '.error', 'missing on a failed step');
      if (s.error !== undefined) str(s, 'error', p);
      if (s.changedInSha !== undefined) str(s, 'changedInSha', p);
    });
  }

  if (Array.isArray(story.steps)) {
    const seen = new Map();
    for (const s of story.steps) if (isObj(s) && Array.isArray(s.hunks)) for (const h of s.hunks) if (isObj(h) && isStr(h.id)) seen.set(h.id, (seen.get(h.id) || 0) + 1);
    for (const [id, n] of seen) if (n > 1) bad('story.steps', 'hunk ' + id + ' is in ' + n + ' steps');
    if (hunks) {
      const expected = new Set(hunks.map((h) => h.id));
      for (const h of hunks) if (!seen.has(h.id)) bad('story.steps', 'hunk ' + h.id + ' (' + h.path + ') is in no step');
      for (const id of seen.keys()) if (!expected.has(id)) bad('story.steps', 'hunk ' + id + ' is not in the diff');
    }
    const skipped = new Set((Array.isArray(story.skippedFiles) ? story.skippedFiles : []).map((f) => f && f.path));
    for (const s of story.steps) if (isObj(s) && Array.isArray(s.hunks)) for (const h of s.hunks) if (isObj(h) && skipped.has(h.path)) bad('story.steps', 'hunk ' + h.id + ' belongs to skipped file ' + h.path);
  }

  return v;
}

function fingerprintOf(path, patch) {
  const changed = patch
    .split('\n')
    .slice(1)
    .filter((l) => l.startsWith('+') || l.startsWith('-'))
    .join('\n');
  return createHash('sha1')
    .update(path + '\n' + changed)
    .digest('hex')
    .slice(0, 16);
}
