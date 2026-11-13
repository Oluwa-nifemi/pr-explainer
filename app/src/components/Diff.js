import { html } from "htm/preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { parsePatch, langOf, hunkStats } from "../lib/diff.js";
import { highlightLines } from "../lib/highlight.js";
import { session, useSession, lineKey, openComposer, closeComposer, addComment, removeComment, saveReply, removeReply, askAbout, live, setHunksViewed, loadFile, expandGap } from "../lib/session.js";
import { cx, dirName, fileName, isRange, memo, rangeLabel } from "../lib/util.js";
import { getThreads, replyThread, setResolved, setReaction } from "../lib/api.js";
import { useSetup } from "../lib/setup.js";
import { isExport } from "../lib/mode.js";

const ago = (iso) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  if (s < 86400 * 14) return Math.round(s / 86400) + "d ago";
  return Math.round(s / 86400 / 7) + "w ago";
};

const toggleThreads = (ids) =>
  session.set((s) => {
    const open = !ids.every((id) => s.openThreads[id]);
    const next = { ...s.openThreads };
    ids.forEach((id) => (next[id] = open));
    return { openThreads: next };
  });

async function refreshThreads() {
  if (!live.prKey) return;
  session.set({ threads: await getThreads(live.prKey, true) });
}

function ThreadMarker({ threads }) {
  const first = threads[0].comments[0];
  const count = threads.reduce((a, t) => a + t.comments.length, 0);
  const resolved = threads.every((t) => t.isResolved);
  return html`<button class=${cx("th-mark", resolved && "resolved")} title=${count + " comment" + (count === 1 ? "" : "s") + (resolved ? " (resolved)" : "")} onClick=${(e) => (e.stopPropagation(), toggleThreads(threads.map((t) => t.id)))}>
    ${first?.author.avatarUrl ? html`<img src=${first.author.avatarUrl} alt="" />` : html`<span class="avatar">${(first?.author.login || "?").slice(0, 2)}</span>`}
    <span>${count}</span>
  </button>`;
}

export function ThreadCard({ t }) {
  const saved = useSession((s) => (s.replies || {})[t.id]);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const run = async (fn) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await refreshThreads();
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  };
  const where =
    t.placement.kind === "file" || t.subjectType === "FILE"
      ? "Comment on file"
      : isRange(t)
      ? "Comment on " + rangeLabel(t)
      : "Comment on line " + (t.side === "LEFT" ? "L" : "R") + (t.line ?? t.originalLine);
  return html`<div class=${cx("thread", t.isResolved && "resolved")} onClick=${(e) => e.stopPropagation()}>
    <div class="thread-head">
      <button class="icon-btn" aria-label="Collapse thread" onClick=${() => toggleThreads([t.id])}>⌄</button>
      <span>${where}</span>
      ${t.isResolved ? html`<span class="tag">Resolved</span>` : null}
      <a class="link" href=${t.url} target="_blank" rel="noreferrer">GitHub ↗</a>
    </div>
    ${t.comments.map(
      (c) => html`<div class="th-comment" key=${c.id}>
        <div class="th-meta">${c.author.avatarUrl ? html`<img src=${c.author.avatarUrl} alt="" />` : null}<b>${c.author.login}</b><span class="muted">${ago(c.createdAt)}</span></div>
        <div class="th-body md" dangerouslySetInnerHTML=${{ __html: c.bodyHtml || c.body }} />
        ${c.reactions?.length ? html`<div class="th-reacts">${c.reactions.map((r) => html`<button class=${cx("react", r.mine && "mine")} disabled=${busy} onClick=${() => run(() => setReaction(c.id, r.content, !r.mine))}>${REACT[r.content] || r.content} ${r.count}</button>`)}</div>` : null}
      </div>`
    )}
    <div class="th-actions">
      ${saved != null
        ? html`<div class="th-draft"><span class="tag">Draft reply, sent with your review</span><div class="th-body">${saved}</div>
            <div class="composer-row"><button class="btn ghost small" onClick=${() => (setReply(saved), removeReply(t.id))}>Edit</button><button class="btn ghost small" onClick=${() => removeReply(t.id)}>Discard</button></div></div>`
        : null}
      <textarea rows="2" placeholder="Write a reply" value=${reply} onInput=${(e) => setReply(e.currentTarget.value)} />
      <div class="composer-row">
        ${err ? html`<span class="th-err">${err}</span>` : html`<span></span>`}
        <button class="btn ghost" disabled=${busy} onClick=${() => run(() => setResolved(t.id, !t.isResolved))}>${t.isResolved ? "Unresolve" : "Resolve"}</button>
        <button class="btn ghost" disabled=${busy || !reply.trim()} onClick=${() => (saveReply(t.id, reply.trim()), setReply(""))}>Save draft</button>
        <button class="btn primary" disabled=${busy || !reply.trim()} onClick=${() => run(async () => (await replyThread(t.id, reply.trim()), setReply("")))}>Reply</button>
      </div>
    </div>
  </div>`;
}

const REACT = { THUMBS_UP: "👍", THUMBS_DOWN: "👎", LAUGH: "😄", HOORAY: "🎉", CONFUSED: "😕", HEART: "❤️", ROCKET: "🚀", EYES: "👀" };

export function CommentCard({ c, onJump, compact }) {
  const author = live.story?.pr.author;
  const me = useSetup().status?.github;
  return html`<div class=${cx("ccard", c.kind === "clarification" && "ask", c.posted && "posted")}>
    <div class="ccard-head">
      ${me?.avatarUrl ? html`<img class="avatar" src=${me.avatarUrl} alt=${me.login || "You"} title=${me.login || "You"} />` : html`<span class="avatar">You</span>`}
      <span class="ccard-kind">${c.kind === "clarification" ? "Question for @" + author : "Comment"}</span>
      ${isRange(c) ? html`<span class="muted ccard-range">${fileName(c.path)} ${rangeLabel(c)}</span>` : null}
      <span class=${cx("badge", c.posted ? "badge-posted" : "badge-draft")}>${c.posted ? (live.prKey ? "Posted" : "Posted (demo)") : "Draft"}</span>
      ${compact ? null : null}
      ${c.posted ? null : html`<button class="icon-btn" title="Delete draft" aria-label="Delete draft" onClick=${() => removeComment(c.id)}>×</button>`}
    </div>
    <div class="ccard-body">${c.body}</div>
    ${onJump ? html`<button class="link ccard-loc" onClick=${onJump}>${fileName(c.path)}${c.scope === "step" ? "" : isRange(c) ? " " + rangeLabel(c) : ":" + c.line}</button>` : null}
  </div>`;
}

function Composer({ target }) {
  const text = useSession((s) => s.composerText);
  const setText = (v) => session.set({ composerText: v });
  const cancel = () => {
    if (text.trim() && !confirm("Discard the comment you started?")) return;
    closeComposer();
  };
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const save = () => {
    const body = text.trim();
    if (!body) return;
    const { id, prefill, snippet, anchor, ...rest } = target;
    addComment({ ...rest, body, kind: "comment" });
  };
  const range = isRange(target);
  const where = `${fileName(target.path)}${range ? " " + rangeLabel(target) : ":" + target.line}`;
  const ask = () => {
    askAbout({
      type: "line",
      label: `${fileName(target.path)}:${range ? target.startLine + "-" + target.line : target.line}`,
      stepId: target.stepId,
      hunkId: target.hunkId,
      path: target.path,
      line: target.line,
      side: target.side,
      snippet: target.snippet || "",
    }, text.trim());
    closeComposer();
  };
  return html`<div class="composer" data-composer>
    <div class="composer-label">Comment on ${range ? rangeLabel(target) : "line " + target.line}</div>
    <textarea
      ref=${ref}
      rows="3"
      value=${text}
      placeholder=${range ? "Leave a comment on these lines" : "Leave a comment on this line"}
      onInput=${(e) => setText(e.currentTarget.value)}
      onKeyDown=${(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
        else if (e.key === "Escape") cancel();
      }}
    />
    <div class="composer-row">
      <span class="composer-meta">Draft on ${where}. Only you see it until you submit the review.</span>
      ${range && !isExport() ? html`<button class="btn ghost" onClick=${ask}>Ask about these lines</button>` : null}
      <button class="btn ghost" onClick=${cancel}>Cancel</button>
      <button class="btn primary" disabled=${!text.trim()} onClick=${save}>Add draft comment <kbd>⌘↵</kbd></button>
    </div>
  </div>`;
}

function HunkView({ hunk, step, hideNote }) {
  const comments = useSession((s) => s.comments);
  const comp = useSession((s) => s.composer);
  const rangeAnchor = useSession((s) => s.rangeAnchor);
  const viewed = useSession((s) => !!s.viewed[hunk.id]);
  const lines = useMemo(() => parsePatch(hunk.patch), [hunk.patch]);
  const lang = langOf(hunk.path);
  const hl = useMemo(() => highlightLines(lines, lang), [lines, lang]);
  const { add, del } = hunkStats(hunk.patch);
  const hunkComments = comments.filter((c) => c.hunkId === hunk.id && c.scope !== "step");
  const allThreads = useSession((s) => s.threads);
  const openThreads = useSession((s) => s.openThreads);
  const hunkThreads = (allThreads?.threads || []).filter((t) => t.placement.kind === "line" && t.placement.hunkId === hunk.id);

  const lineSide = (l) => (l.type === "del" ? "LEFT" : "RIGHT");
  const lineNo = (l) => (l.type === "del" ? l.old : l.new);
  const drag = useRef(null);
  const [preview, setPreview] = useState(null);
  const noClickUntil = useRef(0);

  const snippetFor = (side, a, b) =>
    lines
      .filter((l) => l.type !== "meta" && lineSide(l) === side && lineNo(l) >= a && lineNo(l) <= b)
      .map((l) => l.text)
      .join("\n")
      .slice(0, 400);

  // anchor = the first clicked line. line = the last line of the range, which is GitHub's `line`.
  const select = (side, anchor, line) => {
    const lo = Math.min(anchor, line);
    const hi = Math.max(anchor, line);
    openComposer({
      scope: "line",
      stepId: step.id,
      hunkId: hunk.id,
      path: hunk.path,
      side,
      anchor,
      line: hi,
      ...(lo < hi ? { startLine: lo, startSide: side, snippet: snippetFor(side, lo, hi) } : {}),
    });
  };

  const onRow = (l, shift) => {
    if (Date.now() < noClickUntil.current) return;
    if (!shift && String(window.getSelection?.() || "").length > 0) return;
    const side = lineSide(l);
    const no = lineNo(l);
    const open = session.get().composer;
    const mine = open && open.scope === "line" && open.hunkId === hunk.id && open.side === side;
    const anchor = session.get().rangeAnchor;
    if (shift) {
      if (anchor && anchor.hunkId === hunk.id && anchor.side === side) {
        session.set({ rangeAnchor: null });
        return select(side, anchor.line, no);
      }
      if (mine) return select(side, open.anchor ?? open.line, no);
      session.set({ rangeAnchor: { hunkId: hunk.id, side, line: no } });
      return;
    }
    session.set({ rangeAnchor: null });
    if (mine && open.line === no && open.startLine === undefined) return session.get().composerText.trim() ? undefined : closeComposer();
    select(side, no, no);
  };

  const selectRef = useRef(select);
  selectRef.current = select;
  useEffect(() => {
    const up = () => {
      const d = drag.current;
      drag.current = null;
      setPreview(null);
      if (!d || d.end == null || d.end === d.anchor) return;
      noClickUntil.current = Date.now() + 250;
      selectRef.current(d.side, d.anchor, d.end);
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const startDrag = (l, e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const side = lineSide(l);
    drag.current = { side, anchor: lineNo(l), end: null };
    setPreview({ side, a: lineNo(l), b: lineNo(l) });
  };

  const hoverRow = (l) => {
    const d = drag.current;
    if (!d) return;
    if (lineSide(l) !== d.side) {
      d.end = null;
      setPreview(null);
      return;
    }
    d.end = lineNo(l);
    setPreview({ side: d.side, a: Math.min(d.anchor, d.end), b: Math.max(d.anchor, d.end) });
  };
  const chipFor = (l) => ({ type: "line", label: `${fileName(hunk.path)}:${lineNo(l)}`, stepId: step.id, hunkId: hunk.id, path: hunk.path, line: lineNo(l), side: lineSide(l), snippet: l.text.trim() });

  return html`<div class="hunk" data-hunk=${hunk.id}>
    <div class="hunk-head">
      <code class="hh-range">@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines}</code>
      <span class="hh-ctx">${hunk.header}</span>
      <span class="hh-stats"><b class="plus">+${add}</b> <b class="minus">−${del}</b></span>
      ${isExport() ? null : html`<button class="link" onClick=${() => askAbout({ type: "hunk", label: `${fileName(hunk.path)} · hunk`, stepId: step.id, hunkId: hunk.id, path: hunk.path, line: hunk.newStart, snippet: hunk.header })}>Ask about this hunk</button>`}
      <label class="viewed-toggle"><input type="checkbox" checked=${viewed} onChange=${(e) => setHunksViewed([hunk.id], e.currentTarget.checked)} /><span>Viewed</span></label>
    </div>
    ${viewed ? null : hunk.note && !hideNote ? html`<div class="hunk-note"><span>Note</span>${hunk.note}</div>` : null}
    <div class="dl-wrap">
      ${(viewed ? [] : lines).map((l, i) => {
        if (l.type === "meta") return html`<div class="dl meta" key=${i}><span class="g"></span><span class="g"></span><span class="g"></span><span class="code">${l.text}</span></div>`;
        const no = lineNo(l);
        const side = lineSide(l);
        const key = lineKey(hunk.id, side, no);
        const here = hunkComments.filter((c) => c.line === no && c.side === side);
        const covered = hunkComments.some((c) => c.side === side && no >= (c.startLine ?? c.line) && no <= c.line);
        const th = hunkThreads.filter((t) => t.line === no && t.side === side);
        const open = comp && comp.scope === "line" && comp.hunkId === hunk.id && comp.line === no && comp.side === side;
        const sel = comp && comp.scope === "line" && comp.hunkId === hunk.id && comp.side === side && (comp.startLine !== undefined ? no >= comp.startLine && no <= comp.line : comp.line === no);
        const prev = (preview && preview.side === side && no >= preview.a && no <= preview.b) || (rangeAnchor && rangeAnchor.hunkId === hunk.id && rangeAnchor.side === side && rangeAnchor.line === no);
        return html`<div key=${i}>
          <div
            class=${cx("dl", l.type, open && "open", here.length && "has-c", covered && "has-r", (sel || prev) && "sel", prev && "prev")}
            data-ln=${key}
            onMouseDown=${(e) => e.shiftKey && e.preventDefault()}
            onMouseEnter=${() => hoverRow(l)}
            onClick=${(e) => onRow(l, e.shiftKey)}
          >
            <span class="g tools">
              <button class="tool" title="Add comment" aria-label="Add comment on this line" onMouseDown=${(e) => startDrag(l, e)} onClick=${(e) => (e.stopPropagation(), onRow(l, e.shiftKey))}>+</button>
              ${isExport() ? null : html`<button class="tool ask" title="Ask the assistant about this line" aria-label="Ask about this line" onClick=${(e) => (e.stopPropagation(), askAbout(chipFor(l)))}>?</button>`}
            </span>
            <span class="g no">${l.old ?? ""}</span>
            <span class="g no">${l.new ?? ""}</span>
            <span class="sign">${l.type === "add" ? "+" : l.type === "del" ? "−" : ""}</span>
            <span class="code">${hl[i]}${l.text === "" ? " " : ""}</span>
            ${th.length ? html`<${ThreadMarker} threads=${th} />` : null}
          </div>
          ${th.filter((t) => openThreads[t.id]).map((t) => html`<div class="dl-thread" key=${t.id}><${ThreadCard} t=${t} /></div>`)}
          ${here.map((c) => html`<div class="dl-thread" key=${c.id}><${CommentCard} c=${c} /></div>`)}
          ${open ? html`<div class="dl-thread"><${Composer} target=${comp} /></div>` : null}
        </div>`;
      })}
    </div>
  </div>`;
}

function GapLines({ lines, startNew, delta, lang }) {
  const { rows, hl } = useMemo(() => {
    const rows = lines.map((text, i) => {
      const n = startNew + i;
      return { type: "ctx", text: text ?? "", old: n - delta >= 1 ? n - delta : null, new: n };
    });
    return { rows, hl: highlightLines(rows, lang) };
  }, [lines, startNew, delta, lang]);
  return html`<div class="dl-wrap">${rows.map((l, i) => html`<div class="dl ctx gap-ln" key=${l.new}>
    <span class="g tools"></span>
    <span class="g no">${l.old ?? ""}</span>
    <span class="g no">${l.new}</span>
    <span class="sign"></span>
    <span class="code">${hl[i]}${l.text === "" ? " " : ""}</span>
  </div>`)}</div>`;
}

// Hidden lines between hunks. `above` grows from the hunk above, `below` from the hunk below.
function GapRow({ gapKey, gap, file, path }) {
  const state = useSession((s) => s.gaps[gapKey]);
  const lang = langOf(path);
  const ready = file?.status === "ready";
  const loading = file?.status === "loading";
  const failed = file?.status === "failed";
  const available = ready ? Math.max(0, file.lines.length - gap.startNew + 1) : null;
  const total = gap.count == null ? available : available == null ? gap.count : Math.min(gap.count, available);
  const above = state?.all ? total ?? 0 : Math.min(state?.above || 0, total ?? 0);
  const below = state?.all ? 0 : Math.min(state?.below || 0, Math.max(0, (total ?? 0) - above));
  const rest = total == null ? null : Math.max(0, total - above - below);
  const act = (change) => {
    if (!ready) loadFile(path);
    expandGap(gapKey, change);
  };
  if (total === 0) return null;

  const aboveLines = ready && gap.kind === "between" && above ? file.lines.slice(gap.startNew - 1, gap.startNew - 1 + above) : [];
  const belowStart = gap.kind === "after" ? gap.startNew : gap.startNew + (total ?? 0) - below;
  const belowLines = ready && below ? file.lines.slice(belowStart - 1, belowStart - 1 + below) : [];
  const row = rest === 0 ? null : html`<div class="gap-row">
    ${total == null ? null : html`<span class="gap-count">${rest} hidden line${rest === 1 ? "" : "s"}</span>`}
    ${isExport()
      ? null
      : loading
      ? html`<span class="gap-note">Loading lines…</span>`
      : failed
      ? html`<span class="gap-err">Could not load this file. ${file.error || ""}</span><button class="link" onClick=${() => loadFile(path, { force: true })}>Retry</button>`
      : total == null
      ? html`<button class="link" onClick=${() => act({ below: 20 })}>Show more below</button>`
      : html`${rest > 20 && gap.kind === "between" ? html`<button class="link" onClick=${() => act({ above: above + 20 })}>Show 20 above</button>` : null}
          ${rest > 20 ? html`<button class="link" onClick=${() => act({ below: below + 20 })}>Show 20 below</button>` : null}
          <button class="link" onClick=${() => act({ all: true })}>Show all</button>`}
  </div>`;
  const aboveBlock = aboveLines.length ? html`<${GapLines} lines=${aboveLines} startNew=${gap.startNew} delta=${gap.delta} lang=${lang} />` : null;
  const belowBlock = belowLines.length ? html`<${GapLines} lines=${belowLines} startNew=${belowStart} delta=${gap.delta} lang=${lang} />` : null;
  if (gap.kind === "after") return html`${belowBlock}${row}`;
  if (gap.kind === "between") return html`${aboveBlock}${row}${belowBlock}`;
  return html`${row}${belowBlock}`;
}

function FileBlockImpl({ path, hunks, step, bare }) {
  const allThreads = useSession((s) => s.threads);
  const openThreads = useSession((s) => s.openThreads);
  const file = useSession((s) => s.files[path]);
  const fileThreads = (allThreads?.threads || []).filter((t) => t.placement.kind === "file" && t.path === path && t.placement.stepId === step.id);
  const first = hunks[0];
  const isNew = first.oldStart === 0 && first.oldLines === 0;
  const isDeleted = first.newStart === 0 && first.newLines === 0;
  const total = hunks.reduce((a, h) => {
    const st = hunkStats(h.patch);
    return { add: a.add + st.add, del: a.del + st.del };
  }, { add: 0, del: 0 });
  const parts = [];
  if (isNew || isDeleted) {
    hunks.forEach((h) => parts.push({ hunk: h }));
  } else {
    if (first.newStart > 1) {
      parts.push({ gap: { kind: "before", startNew: 1, count: first.newStart - 1, delta: first.newStart - first.oldStart } });
    }
    hunks.forEach((h, i) => {
      parts.push({ hunk: h });
      const next = hunks[i + 1];
      if (!next) return;
      const startNew = h.newStart + h.newLines;
      const count = next.newStart - startNew;
      if (count > 0) parts.push({ gap: { kind: "between", startNew, count, delta: startNew - (h.oldStart + h.oldLines) } });
    });
    const last = hunks[hunks.length - 1];
    const startNew = last.newStart + last.newLines;
    parts.push({ gap: { kind: "after", startNew, count: null, delta: startNew - (last.oldStart + last.oldLines) } });
  }
  return html`<section class="file" data-file=${bare ? null : step.id + "|" + path}>
    ${bare ? null : html`<header class="file-head">
      <span class="file-path"><span class="dir">${dirName(path)}/</span><b>${fileName(path)}</b></span>
      ${isNew ? html`<span class="tag tag-add">new file</span>` : isDeleted ? html`<span class="tag tag-del">deleted</span>` : null}
      <span class="hh-stats"><b class="plus">+${total.add}</b> <b class="minus">−${total.del}</b></span>
      ${fileThreads.length ? html`<${ThreadMarker} threads=${fileThreads} />` : null}
    </header>`}
    ${fileThreads.filter((t) => openThreads[t.id]).map((t) => html`<div class="dl-thread" key=${t.id}><${ThreadCard} t=${t} /></div>`)}
    ${parts.map((p, i) =>
      p.hunk
        ? html`<${HunkView} key=${p.hunk.id} hunk=${p.hunk} step=${step} hideNote=${bare} />`
        : html`<${GapRow} key=${i} gapKey=${step.id + "|" + path + "|" + i} gap=${p.gap} file=${file} path=${path} />`
    )}
  </section>`;
}

export const FileBlock = memo(FileBlockImpl);

export function groupByFile(hunks) {
  const map = new Map();
  hunks.forEach((h) => {
    if (!map.has(h.path)) map.set(h.path, []);
    map.get(h.path).push(h);
  });
  return [...map.entries()].map(([path, list]) => ({ path, hunks: list }));
}
