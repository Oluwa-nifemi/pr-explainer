import { langOf, parsePatch } from "./diff.js";
import { isRange } from "./util.js";

// GitHub's per-file diff anchor is "diff-" + sha256 of the path, and a line anchor adds R<line> or L<line>.
const sha256 = async (text) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export const prUrl = (story) => `https://github.com/${story.pr.repo}/pull/${story.pr.number}`;

async function lineUrl(story, c) {
  const base = prUrl(story);
  if (!c.path || c.line == null) return base;
  const side = c.side === "LEFT" ? "L" : "R";
  return `${base}/files#diff-${await sha256(c.path)}${side}${c.line}`;
}

const codeAt = (story, c) => {
  if (c.line == null) return "";
  const hunk = story.steps.flatMap((s) => s.hunks || []).find((h) => h.id === c.hunkId);
  if (!hunk) return "";
  const side = c.side || "RIGHT";
  const lo = c.startLine ?? c.line;
  return parsePatch(hunk.patch)
    .filter((l) => l.type !== "meta")
    .map((l) => ({ side: l.type === "del" ? "LEFT" : "RIGHT", no: l.type === "del" ? l.old : l.new, text: l.text }))
    .filter((l) => l.side === side && l.no >= lo && l.no <= c.line)
    .map((l) => l.text)
    .join("\n");
};

const where = (c) => {
  if (!c.path) return "General";
  if (c.line == null) return c.path;
  return c.path + ":" + (isRange(c) ? c.startLine + "-" + c.line : c.line);
};

// An exported file has no service behind it, so the review is shown in the page and leaves as markdown to paste into GitHub.
export async function buildReview(story, { comments, summary }) {
  const links = {};
  for (const c of comments) links[c.id] = await lineUrl(story, c);
  const items = comments.map((c) => ({
    id: c.id,
    where: where(c),
    code: codeAt(story, c),
    lang: c.path ? langOf(c.path) : "txt",
    body: (c.body || "").trim(),
    href: links[c.id],
  }));
  const head = [`**${story.pr.repo} #${story.pr.number}**`, prUrl(story), (summary || "").trim()].filter(Boolean).join("\n\n");
  const blocks = items.map((it) =>
    ["**" + it.where + "**", it.code ? "```" + it.lang + "\n" + it.code + "\n```" : "", it.body, it.href ? "[Open on GitHub](" + it.href + ")" : ""]
      .filter(Boolean)
      .join("\n\n")
  );
  return { text: [head, ...blocks].join("\n\n---\n\n") + "\n", links, items };
}

export function downloadMarkdown(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const reviewFileName = (story) => `${story.pr.repo.replace("/", "-")}-${story.pr.number}-review.md`;
