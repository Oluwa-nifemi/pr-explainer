import { createHash } from 'node:crypto';

import { fileRegexes, hiddenRoles, maxFileChangedLines } from './settings.js';

// File rules live in settings.js, where a user can change them.
const matches = (group, path) => fileRegexes(group).some((r) => r.test(path));

export function isGenerated(file) {
  if (matches('generated', file.path)) return true;
  return (file.hunks || []).some((h) => h.lines.slice(1, 6).some((l) => /@generated|DO NOT EDIT|auto-?generated/i.test(l)));
}

export function fileRole(file) {
  const path = typeof file === 'string' ? file : file.path;
  if (typeof file === 'string' ? matches('generated', path) : isGenerated(file)) return 'generated';
  if (matches('test', path)) return 'test';
  if (matches('config', path)) return 'config';
  if (matches('docs', path)) return 'docs';
  return 'source';
}

export function changedLines(hunk) {
  let n = 0;
  for (const l of hunk.lines) if (l[0] === '+' || l[0] === '-') n++;
  return n;
}

export function planSize(files) {
  let n = 0;
  for (const f of files) {
    if (f.fileRole === 'test' || f.fileRole === 'generated') continue;
    for (const h of f.hunks) n += changedLines(h);
  }
  return n;
}

export function stepRange(lines) {
  if (lines <= 150) return [1, 2];
  if (lines <= 600) return [2, 4];
  if (lines <= 1500) return [3, 6];
  return [4, 8];
}

export function parseDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      file = { oldPath: m?.[1], path: m?.[2], status: 'modified', binary: false, hunks: [], additions: 0, deletions: 0 };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'removed';
      else if (line.startsWith('rename from ')) { file.status = 'renamed'; file.oldPath = line.slice(12); }
      else if (line.startsWith('rename to ')) file.path = line.slice(10);
      else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) file.binary = true;
      else if (line.startsWith('--- ')) { const p = line.slice(4); if (p !== '/dev/null') file.oldPath = p.replace(/^a\//, ''); }
      else if (line.startsWith('+++ ')) { const p = line.slice(4); if (p !== '/dev/null') file.path = p.replace(/^b\//, ''); }
    }
    const hm = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/);
    if (hm) {
      hunk = {
        index: file.hunks.length,
        oldStart: +hm[1], oldLines: hm[2] === undefined ? 1 : +hm[2],
        newStart: +hm[3], newLines: hm[4] === undefined ? 1 : +hm[4],
        header: hm[5] || '',
        lines: [line],
      };
      file.hunks.push(hunk);
      continue;
    }
    if (hunk) {
      hunk.lines.push(line);
      if (line.startsWith('+')) file.additions++;
      else if (line.startsWith('-')) file.deletions++;
    }
  }
  for (const f of files) {
    for (const h of f.hunks) {
      h.id = f.path + '#' + h.index;
      h.path = f.path;
      h.patch = h.lines.join('\n');
    }
  }
  return files;
}

const blankOnly = (file) =>
  file.status !== 'modified' &&
  file.hunks.length > 0 &&
  file.hunks.every((h) => h.patch.split('\n').slice(1).every((l) => !/^[+-]/.test(l) || /^[+-]\s*$/.test(l)));

export function skipReason(file) {
  if (matches('custom', file.path)) return 'ignored';
  if (matches('lockfile', file.path)) return 'lockfile';
  if (matches('snapshot', file.path)) return 'snapshot';
  if (file.binary || matches('binary', file.path)) return 'binary';
  if (isGenerated(file)) return 'generated';
  if (file.additions + file.deletions > maxFileChangedLines()) return 'too-large';
  if (blankOnly(file)) return 'empty';
  if (!file.hunks.length) return 'other';
  if (hiddenRoles().has(fileRole(file))) return 'excluded';
  return null;
}

export function prepare(diffText) {
  const files = parseDiff(diffText);
  const kept = [];
  const skippedFiles = [];
  for (const f of files) {
    const reason = skipReason(f);
    if (reason) skippedFiles.push({ path: f.path, reason, file: f });
    else kept.push(f);
  }
  if (!kept.length) {
    for (let i = skippedFiles.length - 1; i >= 0; i--) {
      if (skippedFiles[i].reason === 'generated' && skippedFiles[i].file.hunks.length) kept.unshift(skippedFiles.splice(i, 1)[0].file);
    }
  }
  for (const s of skippedFiles) delete s.file;
  const hunks = [];
  kept.forEach((f, fi) => {
    f.alias = 'f' + (fi + 1);
    f.fileRole = fileRole(f);
    for (const h of f.hunks) {
      h.alias = 'h' + (hunks.length + 1);
      h.fileAlias = f.alias;
      h.fileStatus = f.status;
      h.fileRole = f.fileRole;
      if (f.status === 'renamed' && f.oldPath && f.oldPath !== f.path) h.oldPath = f.oldPath;
      h.fingerprint = hunkFingerprint(h.path, h);
      hunks.push(h);
    }
  });
  return { files: kept, hunks, skippedFiles };
}

export function hunkFingerprint(path, hunk) {
  const changed = hunk.lines.filter((l) => l.startsWith('+') || l.startsWith('-')).join('\n');
  return createHash('sha1').update(path + '\n' + changed).digest('hex').slice(0, 16);
}

export function numberedPatch(h) {
  let oldNo = h.oldStart;
  let newNo = h.newStart;
  const out = [h.lines[0]];
  for (const l of h.lines.slice(1)) {
    if (l.startsWith('+')) out.push(String(newNo++).padStart(5) + ' ' + l);
    else if (l.startsWith('-')) out.push(String(oldNo++).padStart(5).replace(/\d/g, ' ') + ' ' + l);
    else if (l.startsWith('\\')) out.push('      ' + l);
    else { out.push(String(newNo++).padStart(5) + ' ' + l); oldNo++; }
  }
  return out.join('\n');
}

export function truncatePatch(text, maxLines) {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  const head = Math.floor(maxLines * 0.7);
  const tail = maxLines - head;
  return [...lines.slice(0, head), '... [' + (lines.length - maxLines) + ' lines omitted] ...', ...lines.slice(-tail)].join('\n');
}

export function hunkBlock(h, { numbered = false, maxLines = 400 } = {}) {
  const body = numbered ? numberedPatch(h) : h.patch;
  const tags = [h.fileRole, h.fileStatus === 'added' ? 'new file' : h.fileStatus === 'removed' ? 'deleted file' : ''].filter((x) => x && x !== 'source');
  return '[' + h.alias + '] ' + h.path + (tags.length ? ' (' + tags.join(', ') + ')' : '') + '\n' + truncatePatch(body, maxLines);
}

export function expandHunkRefs(refs, hunks) {
  const byAlias = new Map(hunks.map((h, i) => [h.alias, i]));
  const fileAliases = new Map();
  for (const h of hunks) {
    if (!fileAliases.has(h.fileAlias)) fileAliases.set(h.fileAlias, []);
    fileAliases.get(h.fileAlias).push(h.alias);
  }
  const out = [];
  for (const raw of refs || []) {
    const r = String(raw).trim().replace(/^\[|\]$/g, '');
    const range = r.match(/^h(\d+)\s*-\s*h?(\d+)$/);
    if (range) {
      for (let i = +range[1]; i <= +range[2]; i++) out.push('h' + i);
    } else if (fileAliases.has(r)) {
      out.push(...fileAliases.get(r));
    } else if (byAlias.has(r)) {
      out.push(r);
    } else {
      const h = hunks.find((x) => x.id === r);
      if (h) out.push(h.alias);
      else out.push(r);
    }
  }
  return out;
}
