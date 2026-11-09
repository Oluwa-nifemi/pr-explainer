function hunkRange(hunk, side) {
  return side === 'LEFT'
    ? { start: hunk.oldStart, count: hunk.oldLines }
    : { start: hunk.newStart, count: hunk.newLines };
}

export function hunkFor(story, path, side, line) {
  if (!story || typeof line !== 'number') return null;
  for (const step of story.steps || []) {
    for (const hunk of step.hunks || []) {
      if (hunk.path !== path) continue;
      const { start, count } = hunkRange(hunk, side);
      if (typeof start !== 'number' || typeof count !== 'number') continue;
      if (line >= start && line <= start + count - 1) return { step, hunk };
    }
  }
  return null;
}

function stepForFile(story, path) {
  return (story?.steps || []).find((step) => (step.hunks || []).some((hunk) => hunk.path === path)) || null;
}

export function placeThread(thread, story) {
  const fileStep = stepForFile(story, thread.path);
  if (thread.subjectType === 'FILE') {
    return fileStep ? { kind: 'file', stepId: fileStep.id, hunkId: null } : { kind: 'outdated', stepId: null, hunkId: null };
  }
  if (!story || thread.line === null || thread.line === undefined) {
    return { kind: 'outdated', stepId: null, hunkId: null };
  }
  const found = hunkFor(story, thread.path, thread.side, thread.line);
  if (found) return { kind: 'line', stepId: found.step.id, hunkId: found.hunk.id };
  if (fileStep) return { kind: 'file', stepId: fileStep.id, hunkId: null };
  return { kind: 'outdated', stepId: null, hunkId: null };
}
