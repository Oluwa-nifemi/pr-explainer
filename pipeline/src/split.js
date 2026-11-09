import { changedLines, hunkFingerprint } from './diff.js';
import { jsonCall } from './llm.js';

const MIN_CHANGED = 150;
const MAX_SEGMENTS = 6;
const MIN_SEGMENT_LINES = 15;

const splitSchema = {
  name: 'pr_hunk_split',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['segments'],
    properties: {
      segments: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'startLine'],
          properties: { title: { type: 'string' }, startLine: { type: 'integer' } },
        },
      },
    },
  },
};

const isBlank = (l) => l.slice(1).trim() === '';

function splitPrompt(prTitle, h, body) {
  return [
    'PR title: ' + prTitle,
    'File: ' + h.path + (h.fileStatus === 'added' ? ' (new file)' : ''),
    '',
    'This file change is one hunk. Decide whether a reviewer should read it as several separate parts.',
    'Split it only when it holds clearly different goals that a reviewer would judge on their own. Otherwise return one segment that starts at line 1.',
    'Start each segment at the first line of a function, class or block, including the comment above it. Never cut inside a function.',
    'Each segment must be at least ' + MIN_SEGMENT_LINES + ' lines. Return at most ' + MAX_SEGMENTS + ' segments.',
    'Return only startLine for each segment, in order. The first segment starts at line 1. A segment runs until the next one starts.',
    'title: max 8 words, name the purpose of the part.',
    '',
    body.map((l, i) => i + 1 + '| ' + l).join('\n'),
  ].join('\n');
}

function normalise(segments, body) {
  const starts = [];
  for (const s of [...segments].sort((a, b) => a.startLine - b.startLine)) {
    let p = Math.min(Math.max(1, s.startLine), body.length);
    while (p < body.length && isBlank(body[p - 1])) p++;
    if (starts.length && p <= starts.at(-1).start) continue;
    starts.push({ start: p, title: s.title });
  }
  if (!starts.length) return null;
  starts[0].start = 1;
  const merged = [];
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].start - 1 : body.length;
    if (merged.length && end - s.start + 1 < MIN_SEGMENT_LINES) merged.at(-1).end = end;
    else merged.push({ ...s, end });
  });
  return merged.slice(0, MAX_SEGMENTS).map((s, i, a) => (i === a.length - 1 ? { ...s, end: body.length } : s));
}

function subHunks(h, ranges) {
  const body = h.lines.slice(1);
  let oldNext = h.oldLines === 0 ? h.oldStart + 1 : h.oldStart;
  let newNext = h.newLines === 0 ? h.newStart + 1 : h.newStart;
  return ranges.map((r) => {
    const lines = body.slice(r.start - 1, r.end);
    let oldN = 0;
    let newN = 0;
    for (const l of lines) {
      if (l[0] === '+') newN++;
      else if (l[0] === '-') oldN++;
      else if (l[0] !== '\\') {
        oldN++;
        newN++;
      }
    }
    const sub = {
      ...h,
      oldStart: oldN === 0 ? oldNext - 1 : oldNext,
      oldLines: oldN,
      newStart: newN === 0 ? newNext - 1 : newNext,
      newLines: newN,
      splitTitle: r.title,
    };
    oldNext += oldN;
    newNext += newN;
    sub.lines = ['@@ -' + sub.oldStart + ',' + oldN + ' +' + sub.newStart + ',' + newN + ' @@' + (h.header ? ' ' + h.header : ''), ...lines];
    sub.patch = sub.lines.join('\n');
    sub.fingerprint = hunkFingerprint(sub.path, sub);
    return sub;
  });
}

function realias(prep) {
  let n = 0;
  for (const f of prep.files) {
    f.hunks.forEach((h, i) => {
      h.index = i;
      h.id = h.path + '#' + i;
      h.alias = 'h' + ++n;
    });
  }
  prep.hunks = prep.files.flatMap((f) => f.hunks);
}

export async function splitLargeHunks(prep, { prTitle, model, priority, signal, calls }) {
  const targets = prep.hunks.filter((h) => h.fileRole !== 'test' && h.fileRole !== 'generated' && changedLines(h) >= MIN_CHANGED);
  if (!targets.length) return [];
  const results = await Promise.all(
    targets.map(async (h) => {
      const body = h.lines.slice(1);
      try {
        const { value } = await jsonCall(
          { label: 'split ' + h.path, model, messages: [{ role: 'user', content: splitPrompt(prTitle, h, body) }], schema: splitSchema, maxTokens: 2000, priority, signal },
          (v) => (Array.isArray(v.segments) && v.segments.length ? null : 'segments is empty'),
          { calls, retries: 1 }
        );
        const ranges = normalise(value.segments, body);
        return ranges && ranges.length > 1 ? { h, ranges } : null;
      } catch (e) {
        if (e.aborted || signal?.aborted) throw e;
        console.warn('[pr-explainer] split failed for ' + h.path + ': ' + String(e.message || e));
        return null;
      }
    })
  );
  const done = results.filter(Boolean);
  for (const { h, ranges } of done) {
    const file = prep.files.find((f) => f.hunks.includes(h));
    const subs = subHunks(h, ranges);
    file.hunks.splice(file.hunks.indexOf(h), 1, ...subs);
  }
  if (done.length) realias(prep);
  return done.map(({ h, ranges }) => ({ path: h.path, parts: ranges.map((r) => r.title + ' (' + r.start + '-' + r.end + ')') }));
}
