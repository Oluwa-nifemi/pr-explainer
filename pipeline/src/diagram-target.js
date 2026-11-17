export function diagramTarget(hunks, node) {
  if (typeof node.path !== 'string' || !Number.isInteger(node.line) || node.line < 1) return null;
  for (const hunk of hunks) {
    if (hunk.path !== node.path) continue;
    let line = hunk.newStart;
    for (const text of hunk.patch.split('\n')) {
      if (text.startsWith('@@')) continue;
      if (!text.startsWith('+') && !text.startsWith(' ')) continue;
      if (line === node.line) return { hunkId: hunk.id, path: hunk.path, line };
      line++;
    }
  }
  return null;
}
