import { session, live, goStep, jumpToLine, addComment } from "./session.js";
import { getChat, streamChat } from "./api.js";
import { setup } from "./setup.js";
import { uid, fileName, stepNumber } from "./util.js";

let controller = null;

export function abortChat() {
  controller?.abort();
  controller = null;
}

export async function loadChat(key) {
  try {
    const t = await getChat(key);
    session.set({ chat: t.messages, chatLoaded: true });
  } catch (e) {
    session.set({ chatLoaded: true, chatError: { message: e.message } });
  }
}

const clip = (s, n = 400) => (s.length > n ? s.slice(0, n) + "…" : s);

function contextOf(chip) {
  if (!chip) return undefined;
  const c = {};
  if (chip.stepId) c.stepId = chip.stepId;
  if (chip.hunkId) c.hunkId = chip.hunkId;
  if (chip.path) c.path = chip.path;
  if (chip.type === "line") {
    c.line = chip.line;
    c.side = chip.side;
  }
  return c;
}

// Sent with every question. The model only reads them when the reviewer asks about his drafts.
function collectDrafts() {
  const s = session.get();
  const comments = s.comments
    .filter((c) => !c.posted)
    .map((c) => ({ kind: c.kind === "clarification" ? "question" : "comment", path: c.path, line: c.line, startLine: c.startLine, side: c.side, body: c.body }));
  const known = s.threads?.threads || [];
  const replies = Object.entries(s.replies || {}).map(([id, body]) => {
    const t = known.find((x) => x.id === id);
    return { path: t?.path, line: t?.line, replyingTo: t?.comments?.[0]?.author?.login, body };
  });
  return comments.length || replies.length ? { comments, replies } : undefined;
}

export function sendChat(text) {
  const s = session.get();
  const typed = text.trim();
  if (!typed || s.chatLive || !live.prKey) return;
  const chip = s.ctx[0] || null;
  const quoted = chip && (chip.type === "quote" || chip.type === "question") && chip.snippet;
  const message = quoted ? "About: “" + clip(chip.snippet) + "”\n\n" + typed : typed;
  session.set({ ctx: [] });
  run({ message, model: s.chatModel || setup.get().status?.storyModel || "deepseek", context: contextOf(chip), drafts: collectDrafts() }, false);
}

export function retryChat() {
  const e = session.get().chatError;
  if (e?.request && !session.get().chatLive) run(e.request, true);
}

async function run(request, retry) {
  const key = live.prKey;
  abortChat();
  const ctl = (controller = new AbortController());
  const last = session.get().chat.at(-1);
  let mine = retry && last?.role === "user" ? last.id : uid("pending");
  if (mine !== last?.id) {
    const pending = { id: mine, role: "user", text: request.message, context: request.context, createdAt: new Date().toISOString() };
    session.set((s) => ({ chat: [...s.chat, pending] }));
  }
  session.set({ chatLive: { text: "", lookups: [] }, chatError: null });
  let finished = false;
  const fail = (message) => {
    finished = true;
    session.set({ chatLive: null, chatError: { message, request } });
  };
  const onEvent = (type, d) => {
    if (ctl.signal.aborted) return;
    if (type === "user") {
      const id = mine;
      mine = d.id;
      session.set((s) => ({ chat: s.chat.map((m) => (m.id === id ? d : m)) }));
    } else if (type === "lookup") session.set((s) => ({ chatLive: { ...s.chatLive, lookups: [...s.chatLive.lookups, d] } }));
    else if (type === "delta") session.set((s) => ({ chatLive: { ...s.chatLive, text: s.chatLive.text + d.text } }));
    else if (type === "done") {
      finished = true;
      session.set((s) => ({ chat: [...s.chat, d], chatLive: null }));
    } else if (type === "error") fail(d.message || "The answer failed.");
  };
  try {
    await streamChat(key, request, onEvent, ctl.signal);
    if (!finished && !ctl.signal.aborted) fail("The connection closed before the answer finished.");
  } catch (e) {
    if (e.name !== "AbortError") fail(e.message);
  }
}

export function findRef(path, line) {
  const story = live.story;
  if (!story) return null;
  for (const step of story.steps) {
    if (step.status !== "ready") continue;
    for (const h of step.hunks) {
      if ((h.path === path || h.path.endsWith("/" + path)) && line >= h.newStart && line < h.newStart + Math.max(1, h.newLines)) return { step, hunk: h, line };
    }
  }
  return null;
}

export function openRef({ step, hunk, line }) {
  goStep(step.id);
  setTimeout(() => jumpToLine({ stepId: step.id, path: hunk.path, line }), 450);
}

export function addDraftComment(msgId, d) {
  const hit = findRef(d.path, d.line);
  const stepId = hit?.step.id || d.stepId || session.get().current;
  addComment({ scope: "line", stepId, hunkId: hit?.hunk.id || null, path: d.path, line: d.line, side: d.side || "RIGHT", body: d.body, kind: "comment" });
  session.set((s) => ({ addedDrafts: { ...s.addedDrafts, [msgId]: true } }));
}

export function contextChip(ctx, story) {
  if (!ctx) return null;
  if (ctx.line) return { type: "line", label: fileName(ctx.path) + ":" + ctx.line };
  if (ctx.hunkId && ctx.path) return { type: "hunk", label: fileName(ctx.path) + " · hunk" };
  const step = ctx.stepId && story?.steps.find((s) => s.id === ctx.stepId);
  if (step) return { type: "step", label: "Step " + step.order + " · " + step.title };
  return null;
}

export function suggestionsFor(story, stepId) {
  if (!stepId) return ["What is the biggest risk in this PR?", "Where should I start?"];
  const n = stepNumber(story, stepId);
  return ["Why is it designed this way?", "What could go wrong here?", n === 1 ? "What should I check first?" : "How does this connect to the earlier steps?"];
}

export function fakeSummary(verdict, comments) {
  const intro = verdict === "approve" ? "Looks good to me." : verdict === "request_changes" ? "I would like a few changes before this merges." : "A few notes from my read-through.";
  const list = comments.slice(0, 4).map((c) => "- " + c.body.replace(/\s+/g, " ").slice(0, 110) + (c.body.length > 110 ? "…" : ""));
  const body = list.length ? `\n\n${list.join("\n")}${comments.length > 4 ? `\n- and ${comments.length - 4} more inline` : ""}` : "";
  return `${intro}${body}`;
}
