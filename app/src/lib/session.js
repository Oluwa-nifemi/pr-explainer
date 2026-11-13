import { createStore } from "./store.js";
import { uid } from "./util.js";
import { nodeTarget } from "./prepare.js";
import { getFile } from "./api.js";

// The story being viewed. Set by the story page so actions can look up steps and hunks.
export const live = { story: null, prKey: null, exportKey: null };

const initial = () => ({
  view: "overview", // "overview" | "walk"
  current: null, // current step id
  reviewed: {}, // stepId -> true
  comments: [], // draft comments
  replies: {}, // threadId -> draft reply text, posted with the review
  composer: null, // open inline composer target
  rangeAnchor: null,
  composerText: "", // text typed in the open composer; kept when the composer moves to another line
  chat: [], // ChatMessage[] from the service
  chatLive: null, // answer being streamed: { text, lookups }
  chatError: null, // { message, request } of the last failed send
  chatLoaded: false,
  addedDrafts: {}, // assistant message id -> true once its draft became a review comment
  ctx: [], // context chips for the next question
  tab: "step", // aside tab: step | plan | files | chat | comments
  chatModel: null, // "deepseek" | "opus" | null (follows the story model)
  asideOpen: false, // overview: is the aside open
  focusChat: 0,
  chatInput: "", // text in the chat input; kept when the aside changes tab
  expanded: {},
  files: {}, // path -> { status: "loading" | "ready" | "failed", lines?, error? }. Not persisted.
  gaps: {}, // gapKey -> { above, below, all }
  viewed: {}, // hunkId -> true (the reader collapsed it after reading)
  extrasOpen: {}, // path -> true (test and doc files shown open)
  wrap: typeof localStorage !== "undefined" && localStorage.getItem("prx.wrap") === "1",
  review: { open: false, verdict: "comment", summary: "", status: "idle", submitted: null },
  expandDiagram: null, // diagram shown large
  threads: null, // PRThreads from the service
  openThreads: {}, // threadId -> true when expanded
  toast: null,
  epoch: 0,
});

export const session = createStore(initial());

export function resetSession() {
  hydratedFor = null;
  draftsFor = null;
  const epoch = session.get().epoch + 1;
  session.set({ ...initial(), epoch });
}

// "Viewed" hunks are kept in localStorage per PR, by hunk fingerprint, so they survive a reload and a new push.
// A story saved to a file has no PR key, so it gets a key of its own.
const storeKey = (kind) => {
  const key = live.prKey || live.exportKey;
  return key ? "prx." + kind + "." + key : null;
};
const viewedKey = () => storeKey("viewed");
let hydratedFor = null;
let lastViewed = null;
const readSaved = (key) => {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

// Draft comments are kept in localStorage per PR. Hunks are matched by fingerprint, so a draft follows its code across a new push.
const draftsKey = () => storeKey("drafts");
let draftsFor = null;
let lastComments = null;

function hunkIndex(story) {
  const byId = {};
  const byFp = {};
  const stepOf = {};
  story.steps.forEach((st) => st.hunks.forEach((h) => {
    byId[h.id] = h;
    stepOf[h.id] = st.id;
    if (h.fingerprint) byFp[h.fingerprint] = h;
  }));
  return { byId, byFp, stepOf };
}

export function hydrateDrafts(story) {
  const key = draftsKey();
  if (!key || !story || !story.steps.length || draftsFor === key) return;
  draftsFor = key;
  let saved = [];
  try {
    const v = JSON.parse(localStorage.getItem(key) || "[]");
    if (Array.isArray(v)) saved = v;
  } catch {}
  try {
    const r = JSON.parse(localStorage.getItem(repliesKey()) || "{}");
    if (r && typeof r === "object" && Object.keys(r).length) session.set((s) => ({ replies: { ...r, ...s.replies } }));
  } catch {}
  const idx = hunkIndex(story);
  const restored = saved.map(({ hunkFp, ...c }) => {
    const h = (hunkFp && idx.byFp[hunkFp]) || (c.hunkId && idx.byId[c.hunkId]);
    return h ? { ...c, hunkId: h.id, stepId: idx.stepOf[h.id] } : c;
  });
  if (restored.length) session.set((s) => ({ comments: [...restored.filter((r) => !s.comments.some((c) => c.id === r.id)), ...s.comments] }));
}

const repliesKey = () => storeKey("replies");
let lastReplies = null;
session.sub(() => {
  const key = repliesKey();
  const replies = session.get().replies;
  if (!key || draftsFor !== draftsKey() || replies === lastReplies) return;
  lastReplies = replies;
  try {
    if (Object.keys(replies).length) localStorage.setItem(key, JSON.stringify(replies));
    else localStorage.removeItem(key);
  } catch {}
});

export function saveReply(threadId, body) {
  session.set((s) => ({ replies: { ...s.replies, [threadId]: body } }));
  toast("Reply saved as a draft");
}

export function removeReply(threadId) {
  session.set((s) => {
    const { [threadId]: _, ...rest } = s.replies;
    return { replies: rest };
  });
}

session.sub(() => {
  const key = draftsKey();
  const story = live.story;
  const comments = session.get().comments;
  if (!key || !story || draftsFor !== key || comments === lastComments) return;
  lastComments = comments;
  const idx = hunkIndex(story);
  const drafts = comments.filter((c) => !c.posted).map((c) => ({ ...c, hunkFp: idx.byId[c.hunkId]?.fingerprint }));
  try {
    if (drafts.length) localStorage.setItem(key, JSON.stringify(drafts));
    else localStorage.removeItem(key);
  } catch {}
});

export function hydrateViewed(story) {
  const key = viewedKey();
  if (!key || !story) return;
  const saved = new Set(readSaved(key));
  const found = {};
  story.steps.forEach((st) => st.hunks.forEach((h) => {
    if (h.fingerprint && saved.has(h.fingerprint) && session.get().viewed[h.id] === undefined) found[h.id] = true;
  }));
  hydratedFor = key;
  if (Object.keys(found).length) session.set((s) => ({ viewed: { ...found, ...s.viewed } }));
}

session.sub(() => {
  const key = viewedKey();
  const story = live.story;
  const viewed = session.get().viewed;
  if (!key || !story || hydratedFor !== key || viewed === lastViewed) return;
  lastViewed = viewed;
  const saved = new Set(readSaved(key));
  story.steps.forEach((st) => st.hunks.forEach((h) => {
    if (!h.fingerprint) return;
    if (viewed[h.id]) saved.add(h.fingerprint);
    else saved.delete(h.fingerprint);
  }));
  try {
    localStorage.setItem(key, JSON.stringify([...saved]));
  } catch {}
});

let toastTimer;
export function toast(text, tone = "ok") {
  clearTimeout(toastTimer);
  session.set({ toast: { text, tone, id: uid("t") } });
  toastTimer = setTimeout(() => session.set({ toast: null }), 2600);
}

export const lineKey = (hunkId, side, no) => `${hunkId}|${side}|${no}`;

// ---------- navigation ----------
export function setHash(h) {
  if (location.hash.slice(1) !== h) history.replaceState(null, "", location.pathname + location.search + "#" + h);
}

let navLockUntil = 0;
export const navLocked = () => Date.now() < navLockUntil;

export function showOverview() {
  session.set({ view: "overview" });
  setHash("overview");
  window.scrollTo({ top: 0 });
}

export function goStep(id, { smooth = true, fromOverview = false } = {}) {
  const s = session.get();
  const wasWalk = s.view === "walk";
  session.set({ view: "walk", current: id, tab: wasWalk ? s.tab : "step" });
  setHash(id);
  navLockUntil = Date.now() + (smooth && wasWalk ? 900 : 300);
  const doScroll = () => {
    const el = document.querySelector(`[data-step="${id}"]`);
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - 60;
    window.scrollTo({ top, behavior: smooth && wasWalk ? "smooth" : "auto" });
  };
  if (wasWalk) doScroll();
  else requestAnimationFrame(() => requestAnimationFrame(doScroll));
}

export function stepIndex(story, id) {
  return story.steps.findIndex((s) => s.id === id);
}

export function moveStep(story, delta) {
  const s = session.get();
  if (s.view !== "walk") {
    if (story.steps.length) goStep(story.steps[0].id);
    return;
  }
  const i = stepIndex(story, s.current);
  const next = story.steps[Math.min(story.steps.length - 1, Math.max(0, i + delta))];
  if (next && next.id !== s.current) goStep(next.id);
}

export function jumpToLine({ stepId, path, line }) {
  const story = live.story;
  const step = story.steps.find((s) => s.id === stepId);
  if (!step) return;
  const hunk = step.hunks.find((h) => h.path === path && line >= h.newStart && line < h.newStart + Math.max(1, h.newLines)) || step.hunks.find((h) => h.path === path);
  if (!hunk) return;
  session.set((s) => ({ viewed: { ...s.viewed, [hunk.id]: false } }));
  setTimeout(() => {
    const el = document.querySelector(`[data-ln="${lineKey(hunk.id, "RIGHT", line)}"]`) || document.querySelector(`[data-hunk="${hunk.id}"]`);
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - 180;
    window.scrollTo({ top, behavior: "smooth" });
    navLockUntil = Date.now() + 900;
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1800);
  }, 60);
}

// ---------- review state ----------
function flashAndScroll(el) {
  const top = el.getBoundingClientRect().top + window.scrollY - 180;
  window.scrollTo({ top, behavior: "smooth" });
  navLockUntil = Date.now() + 900;
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1800);
}

export function jumpToHunk({ hunkId, line }) {
  session.set((s) => ({ viewed: { ...s.viewed, [hunkId]: false } }));
  setTimeout(() => {
    const el = (line != null && document.querySelector(`[data-ln="${lineKey(hunkId, "RIGHT", line)}"]`)) || document.querySelector(`[data-hunk="${hunkId}"]`);
    if (el) flashAndScroll(el);
  }, 60);
}

// Scroll the main column to a file's block (first hunk) in a step, or to a test/doc file in the closing section.
export function jumpToFile({ stepId, path }) {
  const find = () => [...document.querySelectorAll("[data-file]")].find((e) => e.dataset.file === (stepId === "extras" ? "extras|" : stepId + "|") + path);
  if (stepId === "extras") session.set((s) => ({ extrasOpen: { ...s.extrasOpen, [path]: true } }));
  setTimeout(() => {
    const el = find();
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - 72;
    navLockUntil = Date.now() + 900;
    window.scrollTo({ top, behavior: "smooth" });
    el.classList.add("flash-file");
    setTimeout(() => el.classList.remove("flash-file"), 1800);
  }, 60);
}

export function setHunksViewed(hunkIds, value) {
  session.set((s) => {
    const next = { ...s.viewed };
    hunkIds.forEach((id) => (value ? (next[id] = true) : delete next[id]));
    return { viewed: next };
  });
}

export function setExtrasOpen(paths, open) {
  session.set((s) => {
    const next = { ...s.extrasOpen };
    paths.forEach((p) => (open ? (next[p] = true) : delete next[p]));
    return { extrasOpen: next };
  });
}

// File content for the gaps between hunks. Loaded on the first expand and kept per path.
export function loadFile(path, { force = false } = {}) {
  const current = session.get().files[path];
  if (!force && current && current.status !== "failed") return;
  const prKey = live.prKey;
  const { epoch } = session.get();
  const set = (value) => {
    if (session.get().epoch !== epoch) return;
    session.set((s) => ({ files: { ...s.files, [path]: value } }));
  };
  if (!prKey) {
    set({ status: "failed", error: "File content is not available for this story." });
    return;
  }
  set({ status: "loading" });
  getFile(prKey, path)
    .then((data) => set({ status: "ready", lines: data.lines }))
    .catch((e) => set({ status: "failed", error: e.message }));
}

export function expandGap(key, change) {
  session.set((s) => ({
    gaps: { ...s.gaps, [key]: { above: 0, below: 0, all: false, ...(s.gaps[key] || {}), ...change } },
  }));
}

// A node in the current step's diagram: jump to its line in this step, else to the step that changes it.
export function jumpToNode(stepId, node) {
  const story = live.story;
  const here = story.steps.find((s) => s.id === stepId);
  const t = nodeTarget(here, node);
  if (t) return jumpToHunk(t);
  for (const s of story.steps) {
    if (s.id === stepId || s.status !== "ready") continue;
    const o = nodeTarget(s, node);
    if (o) {
      goStep(s.id);
      setTimeout(() => jumpToHunk(o), 700);
      return;
    }
  }
}

export function nodeIsLinked(stepId, node) {
  const story = live.story;
  if (!story) return false;
  const here = story.steps.find((s) => s.id === stepId);
  if (nodeTarget(here, node)) return true;
  return story.steps.some((s) => s.id !== stepId && s.status === "ready" && nodeTarget(s, node));
}

export function toggleReviewed(id) {
  session.set((s) => ({ reviewed: { ...s.reviewed, [id]: !s.reviewed[id] } }));
}

// The "r" key. Marking a step reviewed also moves on to the next step. Un-marking stays put.
export function reviewAndNext(story) {
  const s = session.get();
  if (!s.current) return;
  const wasReviewed = Boolean(s.reviewed[s.current]);
  toggleReviewed(s.current);
  if (!wasReviewed) moveStep(story, 1);
}

// ---------- comments ----------
export function openComposer(target) {
  session.set({ composer: { ...target, id: uid("cmp") } });
}
export function closeComposer() {
  session.set({ composer: null, composerText: "", rangeAnchor: null });
}

export function addComment(c) {
  const comment = { id: uid("c"), createdAt: Date.now(), posted: false, ...c };
  session.set((s) => ({ comments: [...s.comments, comment], composer: null, composerText: "", rangeAnchor: null }));
  toast(c.kind === "clarification" ? "Question for the author saved as a draft" : "Draft comment saved");
  return comment;
}

export function removeComment(id) {
  session.set((s) => ({ comments: s.comments.filter((c) => c.id !== id) }));
}

export const draftCount = (s) => s.comments.filter((c) => !c.posted).length + Object.keys(s.replies || {}).length;

// ---------- chat ----------
export function askAbout(chip, draft = "") {
  session.set((s) => ({
    ctx: [{ ...chip, id: uid("ctx") }],
    tab: "chat",
    asideOpen: true,
    focusChat: s.focusChat + 1,
    chatInput: draft ? (s.chatInput.trim() ? s.chatInput.replace(/\s+$/, "") + "\n\n" + draft : draft) : s.chatInput,
  }));
}
export function removeCtx(id) {
  session.set((s) => ({ ctx: s.ctx.filter((c) => c.id !== id) }));
}
export function openChat() {
  session.set((s) => ({ tab: "chat", asideOpen: true, focusChat: s.focusChat + 1 }));
}

import { useStore } from './store.js';
export const useSession = (select) => useStore(session, select);

// A half-made Shift-click range is dropped when the reader clicks anywhere else or presses Escape.
if (typeof document !== "undefined") {
  document.addEventListener(
    "mousedown",
    (e) => {
      if (session.get().rangeAnchor && !e.target.closest?.(".dl, .tool")) session.set({ rangeAnchor: null });
    },
    true
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && session.get().rangeAnchor) session.set({ rangeAnchor: null });
  });
}
