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

// An exported file has no service behind it, so the review leaves as markdown the reader pastes into GitHub.
export async function buildReview(story, { comments, summary, verdict }) {
  const links = {};
  for (const c of comments) links[c.id] = await lineUrl(story, c);
  const head = [`**${story.pr.repo} #${story.pr.number}** · ${verdict}`, prUrl(story), (summary || "").trim()].filter(Boolean).join("\n\n");
  const blocks = comments.map((c) => {
    const code = codeAt(story, c);
    return [
      "**" + where(c) + "**",
      code ? "```" + langOf(c.path) + "\n" + code + "\n```" : "",
      (c.body || "").trim(),
      links[c.id] ? "[Open on GitHub](" + links[c.id] + ")" : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  });
  return { text: [head, ...blocks].join("\n\n---\n\n") + "\n", links };
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
