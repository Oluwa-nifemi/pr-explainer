// Parse one hunk 'patch' string into numbered lines.
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parsePatch(patch) {
  const raw = patch.split("\n");
  const m = HUNK_RE.exec(raw[0]);
  let o = m ? +m[1] : 1;
  let n = m ? +m[3] : 1;
  const lines = [];
  for (const l of raw.slice(1)) {
    const c = l[0];
    if (c === "+") lines.push({ type: "add", text: l.slice(1), old: null, new: n++ });
    else if (c === "-") lines.push({ type: "del", text: l.slice(1), old: o++, new: null });
    else if (c === "\\") lines.push({ type: "meta", text: l, old: null, new: null });
    else lines.push({ type: "ctx", text: l.slice(1), old: o++, new: n++ });
  }
  return lines;
}

export function langOf(path) {
  if (/\.pyi?$/.test(path)) return "py";
  if (/\.(tsx?|jsx?|mjs)$/.test(path)) return "ts";
  if (/\.json$/.test(path)) return "json";
  if (/\.md$/.test(path)) return "md";
  return "txt";
}

export function hunkStats(patch) {
  let add = 0;
  let del = 0;
  for (const l of patch.split("\n").slice(1)) {
    if (l[0] === "+") add++;
    else if (l[0] === "-") del++;
  }
  return { add, del };
}
