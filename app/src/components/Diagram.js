import { html } from "htm/preact";
import { useMemo, useRef, useState } from "preact/hooks";
import { cx } from "../lib/util.js";

const FLOW_KINDS = new Set(["step", "decision", "end"]);
const KIND_TAG = { function: "fn", module: "module", type: "type", service: "service", queue: "queue", ui: "ui", store: "store", external: "external" };
const BADGE = { added: "new", modified: "changed", removed: "removed" };
let uidn = 0;

const NARROW = new Set("iIl.,:;|!'ftrj()[]");
const WIDE = new Set("mwMW@");

// Rough text width in px for the sans font, a little generous so labels never clip.
export function textW(s, fs) {
  let w = 0;
  for (const c of s) w += NARROW.has(c) ? 0.34 : WIDE.has(c) ? 0.88 : c >= "A" && c <= "Z" ? 0.67 : c === " " || c === "/" || c === "-" ? 0.4 : c === "_" ? 0.5 : 0.575;
  return w * fs * 1.05;
}

export const isFlowDiagram = (d) => !!d?.nodes?.length && d.nodes.every((n) => FLOW_KINDS.has(n.kind));

// Lays the classic diagram out at its natural size: one-line labels, boxes and gaps as wide as the text needs.
export function layoutDiagram(d, { showLabels, fontSize }) {
  const nodes = d.nodes;
  const layers = [...new Set(nodes.map((n) => n.layer))].sort((a, b) => a - b);
  const L = layers.length;
  const padX = 14;
  const padTop = 16;
  const padBottom = 14;
  const rowGap = fontSize < 11 ? 8 : 14;
  const elFs = fontSize - 1.5;
  const baseGap = L > 1 ? (showLabels ? 44 : 24) : 0;
  const gaps = Array.from({ length: Math.max(0, L - 1) }, () => baseGap);
  const layerIdx = new Map(layers.map((l, i) => [l, i]));
  const nodeById = Object.fromEntries(nodes.map((n) => [n.id, n]));
  if (showLabels) {
    d.edges.forEach((e) => {
      if (!e.label) return;
      const a = layerIdx.get(nodeById[e.from].layer);
      const b = layerIdx.get(nodeById[e.to].layer);
      if (b === a + 1) gaps[a] = Math.max(gaps[a], Math.ceil(textW(e.label, elFs)) + 22);
    });
  }
  const colW = layers.map((layer) => Math.max(104, Math.ceil(Math.max(...nodes.filter((n) => n.layer === layer).map((n) => textW(n.label, fontSize))) + 26)));
  const colX = [];
  let cx0 = padX;
  layers.forEach((_, i) => {
    colX.push(cx0);
    cx0 += colW[i] + (gaps[i] || 0);
  });
  const W = cx0 - (gaps[L - 1] || 0) + padX;
  const lineH = fontSize * 1.28;
  const boxes = {};
  const cols = layers.map((layer) => nodes.filter((n) => n.layer === layer));
  const nodeH = 12 + 11 + lineH + 9;
  const colH = cols.map((c) => c.length * nodeH + rowGap * (c.length - 1));
  const Hmax = Math.max(...colH);
  const back = d.edges.some((e) => nodeById[e.to].layer < nodeById[e.from].layer);
  const lane = back ? 34 : 0;
  const H = padTop + Hmax + padBottom + lane;
  cols.forEach((col, ci) => {
    let y = padTop + (Hmax - colH[ci]) / 2;
    col.forEach((n) => {
      boxes[n.id] = { n, lines: [n.label], fs: fontSize, x: colX[ci], y, w: colW[ci], h: nodeH };
      y += nodeH + rowGap;
    });
  });

  // spread connection points so parallel edges do not share one pixel
  const outs = {};
  const ins = {};
  d.edges.forEach((e, i) => {
    const f = boxes[e.from];
    const t = boxes[e.to];
    if (t.n.layer > f.n.layer) {
      (outs[e.from] ||= []).push(i);
      (ins[e.to] ||= []).push(i);
    }
  });
  const port = {};
  const spread = (map, key, side) => {
    Object.entries(map).forEach(([id, list]) => {
      const b = boxes[id];
      list.sort((a, b2) => {
        const ea = d.edges[a];
        const eb = d.edges[b2];
        const oa = boxes[side === "out" ? ea.to : ea.from];
        const ob = boxes[side === "out" ? eb.to : eb.from];
        return oa.y - ob.y;
      });
      const step = Math.min(9, (b.h - 18) / Math.max(1, list.length));
      list.forEach((ei, k) => {
        (port[ei] ||= {})[key] = b.y + b.h / 2 + (k - (list.length - 1) / 2) * step;
      });
    });
  };
  spread(outs, "y0", "out");
  spread(ins, "y1", "in");

  const edges = d.edges.map((e, i) => {
    const f = boxes[e.from];
    const t = boxes[e.to];
    let path;
    let lx;
    let ly;
    let isBack = false;
    if (t.n.layer > f.n.layer) {
      const x0e = f.x + f.w;
      const x1e = t.x;
      const y0 = port[i].y0;
      const y1 = port[i].y1;
      const dx = (x1e - x0e) * 0.5;
      path = "M" + x0e + "," + y0 + " C" + (x0e + dx) + "," + y0 + " " + (x1e - dx) + "," + y1 + " " + x1e + "," + y1;
      lx = (x0e + x1e) / 2;
      ly = (y0 + y1) / 2;
    } else if (t.n.layer < f.n.layer) {
      isBack = true;
      const xa = f.x + f.w / 2;
      const ya = f.y + f.h;
      const xb = t.x + t.w / 2;
      const yb = t.y + t.h;
      const ly0 = padTop + Hmax + lane - 6;
      path = "M" + xa + "," + ya + " C" + xa + "," + (ly0 + 14) + " " + xb + "," + (ly0 + 14) + " " + xb + "," + (yb + 1);
      lx = (xa + xb) / 2;
      ly = ly0 + 6;
    } else {
      const upper = f.y < t.y ? f : t;
      const lower = upper === f ? t : f;
      const xc = f.x + f.w / 2;
      const down = f.y < t.y;
      path = down ? "M" + xc + "," + (f.y + f.h) + " L" + xc + "," + (t.y - 1) : "M" + xc + "," + f.y + " L" + xc + "," + (t.y + t.h + 1);
      lx = xc;
      ly = (upper.y + upper.h + lower.y) / 2;
    }
    const lines = e.label ? [e.label] : [];
    return { e, i, path, lx, ly, lines, isBack };
  });
  return { boxes, edges, W, H };
}

const CUBIC = (p0, p1, p2, p3, t) => {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};

const textX = (kind) => (kind === "end" ? 24 : kind === "decision" ? 22 : 16);

// Control flow: forward edges run left to right, only edges that reach a node
// still open in the DFS are loops. node.layer is a tie-break hint only.
function layoutFlow(d, { showLabels, fontSize }) {
  const nodes = d.nodes;
  const all = d.edges;
  const padX = 18;
  const padTop = 20;
  const padBottom = 16;
  const rowGap = 22;
  const nodeH = 44;
  const laneGap = 24;
  const elFs = fontSize - 1.5;
  const pitch = nodeH + rowGap;
  const pillH = elFs + 7;
  const pillW = (s) => textW(s, elFs) + 12;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const listIdx = new Map(nodes.map((n, i) => [n.id, i]));
  const linked = (e) => nodeById.has(e.from) && nodeById.has(e.to);
  const outs = new Map(nodes.map((n) => [n.id, []]));
  const ins = new Map(nodes.map((n) => [n.id, []]));
  all.forEach((e, i) => {
    if (!linked(e)) return;
    outs.get(e.from).push(i);
    ins.get(e.to).push(i);
  });

  // back edges: an edge that reaches a node still open on the DFS stack
  const back = new Set();
  const seen = new Map();
  const walk = (root) => {
    const stack = [[root, 0]];
    seen.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const list = outs.get(top[0]);
      if (top[1] >= list.length) {
        seen.set(top[0], 2);
        stack.pop();
        continue;
      }
      const ei = list[top[1]];
      top[1]++;
      const to = all[ei].to;
      if (to === top[0]) {
        back.add(ei);
        continue;
      }
      if (seen.get(to) === 1) back.add(ei);
      else if (!seen.get(to)) {
        seen.set(to, 1);
        stack.push([to, 0]);
      }
    }
  };
  const roots = nodes.filter((n) => !ins.get(n.id).length).map((n) => n.id);
  [...new Set([nodes.length ? nodes[0].id : null, ...roots, ...nodes.map((n) => n.id)])].forEach((id) => {
    if (id && !seen.get(id)) walk(id);
  });

  // columns: longest path from a source over the forward edges only
  const want = new Map(nodes.map((n) => [n.id, 0]));
  all.forEach((e, i) => {
    if (linked(e) && !back.has(i)) want.set(e.to, want.get(e.to) + 1);
  });
  const colOf = new Map(nodes.map((n) => [n.id, 0]));
  const queue = nodes.filter((n) => !want.get(n.id)).map((n) => n.id);
  for (let qi = 0; qi < queue.length; qi++) {
    const id = queue[qi];
    outs.get(id).forEach((ei) => {
      if (back.has(ei)) return;
      const to = all[ei].to;
      colOf.set(to, Math.max(colOf.get(to), colOf.get(id) + 1));
      want.set(to, want.get(to) - 1);
      if (!want.get(to)) queue.push(to);
    });
  }
  const count = Math.max(...nodes.map((n) => colOf.get(n.id)), 0) + 1;
  const cols = Array.from({ length: count }, () => []);
  nodes.forEach((n) => cols[colOf.get(n.id)].push(n));

  // yes above no, then the order of the incoming edges, then the layer hint
  const branch = (e) => (e.label === "yes" ? 0 : e.label === "no" ? 2 : 1);
  const feed = (n, ci) => ins.get(n.id).find((ei) => !back.has(ei) && colOf.get(all[ei].from) < ci);
  cols.forEach((col, ci) => {
    if (!ci) return;
    const key = new Map(
      col.map((n) => {
        const first = feed(n, ci);
        return [n.id, first === undefined ? [9, 0, n.layer || 0, listIdx.get(n.id)] : [branch(all[first]), first, n.layer || 0, listIdx.get(n.id)]];
      })
    );
    col.sort((a, b) => {
      const ka = key.get(a.id);
      const kb = key.get(b.id);
      for (let k = 0; k < ka.length; k++) if (ka[k] !== kb[k]) return ka[k] - kb[k];
      return 0;
    });
  });

  // column widths and horizontal positions
  const minW = (n) => Math.max(92, Math.ceil(textW(n.label, fontSize)) + textX(n.kind) + 18);
  const colW = cols.map((col) => Math.max(92, ...col.map(minW)));
  const gaps = Array.from({ length: Math.max(0, count - 1) }, () => (showLabels ? 46 : 32));
  if (showLabels) {
    all.forEach((e) => {
      if (!e.label || !linked(e)) return;
      const fi = colOf.get(e.from);
      const ti = colOf.get(e.to);
      if (ti <= fi) return;
      gaps[ti - 1] = Math.max(gaps[ti - 1], Math.ceil(pillW(e.label)) + 24);
    });
  }
  const colX = [];
  let runX = padX;
  cols.forEach((_, i) => {
    colX.push(runX);
    runX += colW[i] + (gaps[i] || 0);
  });
  const W = runX - (gaps[count - 1] || 0) + padX;

  // each column is centred on the rows of its first parents
  const boxes = {};
  const midY = (b) => b.y + b.h / 2;
  cols.forEach((col, ci) => {
    const blockH = col.length * nodeH + Math.max(0, col.length - 1) * rowGap;
    const parents = col.map((n) => {
      const first = feed(n, ci);
      return first === undefined ? null : midY(boxes[all[first].from]);
    });
    const known = parents.filter((v) => v != null);
    const centre = known.length ? known.reduce((a, b) => a + b, 0) / known.length : padTop + blockH / 2;
    const top = Math.max(padTop, centre - blockH / 2);
    col.forEach((n, k) => {
      boxes[n.id] = { n, x: colX[ci], y: top + k * pitch, w: colW[ci], h: nodeH };
    });
  });

  let bottom = padTop;
  Object.values(boxes).forEach((b) => {
    bottom = Math.max(bottom, b.y + b.h);
  });
  let lanes = 0;
  const nextLane = () => bottom + laneGap + lanes++ * laneGap;

  // one exit point (right, mid) and one entry point (left, mid) per node
  const curve = (x0, y0, x1, y1) => {
    if (Math.abs(y1 - y0) < 0.5) return "M" + x0 + "," + y0 + " L" + x1 + "," + y1;
    const dx = Math.max(14, (x1 - x0) * 0.45);
    return "M" + x0 + "," + y0 + " C" + (x0 + dx) + "," + y0 + " " + (x1 - dx) + "," + y1 + " " + x1 + "," + y1;
  };
  const around = (x0, y0, x1, y1, laneY) => {
    const r = Math.max(2, Math.min(10, (laneY - y0) / 2, (laneY - y1) / 2));
    const xs = x0 + 16;
    const xe = x1 - 16;
    return (
      "M" + x0 + "," + y0 +
      " L" + (xs - r) + "," + y0 + " Q" + xs + "," + y0 + " " + xs + "," + (y0 + r) +
      " L" + xs + "," + (laneY - r) + " Q" + xs + "," + laneY + " " + (xs + r) + "," + laneY +
      " L" + (xe - r) + "," + laneY + " Q" + xe + "," + laneY + " " + xe + "," + (laneY - r) +
      " L" + xe + "," + (y1 + r) + " Q" + xe + "," + y1 + " " + (xe + r) + "," + y1 +
      " L" + x1 + "," + y1
    );
  };
  const loop = (x0, y0, x1, y1, laneY) => {
    const r = Math.max(2, Math.min(10, (laneY - y0) / 2, (laneY - y1) / 2));
    const xs = x0 + 16;
    const xe = Math.max(4, x1 - 18);
    return (
      "M" + x0 + "," + y0 +
      " L" + (xs - r) + "," + y0 + " Q" + xs + "," + y0 + " " + xs + "," + (y0 + r) +
      " L" + xs + "," + (laneY - r) + " Q" + xs + "," + laneY + " " + (xs - r) + "," + laneY +
      " L" + (xe + r) + "," + laneY + " Q" + xe + "," + laneY + " " + xe + "," + (laneY - r) +
      " L" + xe + "," + (y1 + r) + " Q" + xe + "," + y1 + " " + (xe + r) + "," + y1 +
      " L" + x1 + "," + y1
    );
  };

  const labelGroup = new Map();
  all.forEach((e, i) => {
    if (!linked(e) || back.has(i) || !e.label || colOf.get(e.to) <= colOf.get(e.from)) return;
    labelGroup.set(e.to, (labelGroup.get(e.to) || 0) + 1);
  });
  const labelAt = new Map();
  const bypassAt = new Map();

  const edges = [];
  all.forEach((e, i) => {
    const f = boxes[e.from];
    const t = boxes[e.to];
    if (!f || !t) return;
    const x0 = f.x + f.w;
    const y0 = f.y + f.h / 2;
    const x1 = t.x;
    const y1 = t.y + t.h / 2;
    const isBack = back.has(i);
    let path;
    let lx;
    let ly;
    if (isBack) {
      const laneY = nextLane();
      const xs = x0 + 16;
      const xe = Math.max(4, x1 - 18);
      path = loop(x0, y0, x1, y1, laneY);
      lx = (xs + xe) / 2;
      ly = laneY;
    } else {
      const bypass = colOf.get(e.to) - colOf.get(e.from) > 1;
      path = bypass ? around(x0, y0, x1, y1, nextLane()) : curve(x0, y0, x1, y1);
      if (bypass) {
        // A skip edge can read as a loop, so its label sits right after the fork, not at the far end.
        const k = e.label ? bypassAt.get(e.from) || 0 : 0;
        if (e.label) bypassAt.set(e.from, k + 1);
        lx = x0 + 18 + pillW(e.label || "") / 2;
        ly = y0 - (pillH + 3) / 2 - k * (pillH + 3);
      } else {
        const group = e.label ? labelGroup.get(e.to) || 1 : 1;
        const k = e.label ? labelAt.get(e.to) || 0 : 0;
        if (e.label) labelAt.set(e.to, k + 1);
        lx = x1 - 10 - pillW(e.label || "") / 2;
        ly = y1 + (k - (group - 1) / 2) * (pillH + 3);
      }
    }
    edges.push({ e, i, path, lx, ly, isBack, lines: e.label ? [e.label] : [] });
  });

  const lastLane = lanes ? bottom + laneGap + (lanes - 1) * laneGap : bottom;
  const H = lastLane + (lanes ? pillH / 2 + 4 : 0) + padBottom;
  return { boxes, edges, W, H };
}

function EdgeDefs({ id }) {
  return html`<defs>
    ${["ink", "accent", "hot"].map(
      (k) => html`<marker id=${"ar-" + id + "-" + k} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0.5,0.8 L7,4 L0.5,7.2 Z" class=${"ah ah-" + k} /></marker>`
    )}
  </defs>`;
}

function EdgeLabels({ edges, fontSize, hotEdge, showLabels }) {
  return html`<g class="labels">
    ${edges
      .filter(({ e, lines }) => lines.length && (showLabels || hotEdge(e)))
      .map(({ e, i, lx, ly, lines }) => {
        const w = textW(lines[0], fontSize - 1.5) + 12;
        const hh = fontSize + 7;
        return html`<g key=${i} class=${cx("elabel", hotEdge(e) && "hot")} transform=${"translate(" + lx + "," + ly + ")"}>
          <rect x=${-w / 2} y=${-hh / 2} width=${w} height=${hh} rx="4" />
          <text text-anchor="middle" y=${(fontSize - 1.5) * 0.35} style=${{ fontSize: fontSize - 1.5 + "px" }}>${lines[0]}</text>
        </g>`;
      })}
  </g>`;
}

function FlowDiagram({ diagram, activeStepId, dimOthers, reviewed = {}, onNodeClick, canClick, showLabels = true, compact = false, maxScale = 1 }) {
  const [hover, setHover] = useState(null);
  const idRef = useRef(++uidn);
  const fontSize = compact ? 10.5 : 11.5;
  const lay = useMemo(() => layoutFlow(diagram, { showLabels, fontSize }), [diagram, showLabels, fontSize]);
  const id = idRef.current;
  const hotEdge = (e) => hover && (e.from === hover || e.to === hover);
  const connected = new Set();
  if (hover) diagram.edges.forEach((e) => (e.from === hover || e.to === hover) && (connected.add(e.from), connected.add(e.to)));

  return html`<div class="diagram" style=${{ maxWidth: Math.round(lay.W * maxScale) + "px" }}>
    <svg viewBox=${"0 0 " + lay.W + " " + lay.H} style=${{ width: "100%", height: "auto" }} role="img" aria-label=${diagram.title || "Diagram"}>
      <${EdgeDefs} id=${id} />
      <g class="edges">
        ${lay.edges.map(({ e, i, path, isBack }) => {
          const hot = hotEdge(e);
          const mk = hot ? "hot" : "ink";
          const faded = hover && !hot;
          return html`<path key=${i} d=${path} class=${cx("edge", hot && "hot", faded && "faded", isBack && "back")} marker-end=${"url(#ar-" + id + "-" + mk + ")"} />`;
        })}
      </g>
      <g class="nodes">
        ${Object.values(lay.boxes).map(({ n, x, y, w, h }) => {
          const active = activeStepId && n.stepId === activeStepId;
          const clickable = !!(onNodeClick && (canClick ? canClick(n) : n.stepId));
          const dim = (dimOthers && activeStepId && !active) || (hover && hover !== n.id && !connected.has(n.id));
          const done = n.stepId && reviewed[n.stepId];
          const badge = BADGE[n.change];
          const ly = h / 2 + fontSize * 0.52 + 2;
          return html`<g
            key=${n.id}
            class=${cx("dnode", "ch-" + n.change, "nk-" + n.kind, active && "active", dim && "dim", clickable && "clickable")}
            transform=${"translate(" + x + "," + y + ")"}
            onClick=${clickable ? () => onNodeClick(n) : null}
            onKeyDown=${clickable ? (ev) => (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), onNodeClick(n)) : null}
            onMouseEnter=${() => setHover(n.id)}
            onMouseLeave=${() => setHover(null)}
            tabindex=${clickable ? 0 : null}
            role=${clickable ? "button" : null}
            aria-label=${clickable ? n.label + ", show in the diff" : n.label}
          >
            ${active ? html`<rect class="halo" x="-3" y="-3" width=${w + 6} height=${h + 6} rx=${n.kind === "end" ? (h + 6) / 2 : 10} />` : null}
            ${n.kind === "decision"
              ? html`<polygon class="nbox" points=${"14,0 " + (w - 14) + ",0 " + w + "," + h / 2 + " " + (w - 14) + "," + h + " 14," + h + " 0," + h / 2} />`
              : html`<rect class="nbox" width=${w} height=${h} rx=${n.kind === "end" ? h / 2 : 8} />`}
            ${badge ? html`<text class="nbadge" x=${w - 12} y="15" text-anchor="end">${badge}</text>` : null}
            <text class="nlabel" x=${textX(n.kind)} y=${ly} style=${{ fontSize: fontSize + "px" }}>${n.label}</text>
            ${done ? html`<g class="ndone" transform=${"translate(" + (w - 9) + "," + (h - 9) + ")"}><circle r="6.5" /><path d="M-3,0 L-0.8,2.4 L3.2,-2.4" /></g>` : null}
          </g>`;
        })}
      </g>
      <${EdgeLabels} edges=${lay.edges} fontSize=${fontSize} hotEdge=${hotEdge} showLabels=${showLabels} />
    </svg>
  </div>`;
}

// Cached v1 stories use code-structure node kinds. Keep their old drawing.
function ClassicDiagram({ diagram, activeStepId, dimOthers, reviewed = {}, onNodeClick, canClick, showLabels = true, compact = false, maxScale = 1 }) {
  const [hover, setHover] = useState(null);
  const idRef = useRef(++uidn);
  const fontSize = compact ? 10.5 : 11.5;
  const lay = useMemo(() => layoutDiagram(diagram, { showLabels, fontSize }), [diagram, showLabels, fontSize]);
  const id = idRef.current;
  const hotEdge = (e) => hover && (e.from === hover || e.to === hover);
  const connected = new Set();
  if (hover) diagram.edges.forEach((e) => (e.from === hover || e.to === hover) && (connected.add(e.from), connected.add(e.to)));

  return html`<div class="diagram" style=${{ maxWidth: Math.round(lay.W * maxScale) + "px" }}>
    <svg viewBox=${"0 0 " + lay.W + " " + lay.H} style=${{ width: "100%", height: "auto" }} role="img" aria-label=${diagram.title || "Diagram"}>
      <${EdgeDefs} id=${id} />
      <g class="edges">
        ${lay.edges.map(({ e, i, path, isBack }) => {
          const hot = hotEdge(e);
          const mk = hot ? "hot" : e.kind === "data" ? "accent" : "ink";
          const faded = hover && !hot;
          return html`<path key=${i} d=${path} class=${cx("edge", "ek-" + (e.kind || "calls"), hot && "hot", faded && "faded", isBack && "back")} marker-end=${"url(#ar-" + id + "-" + mk + ")"} />`;
        })}
      </g>
      <g class="nodes">
        ${Object.values(lay.boxes).map(({ n, lines, fs, x, y, w, h }) => {
          const active = activeStepId && n.stepId === activeStepId;
          const clickable = !!(onNodeClick && (canClick ? canClick(n) : n.stepId));
          const dim = (dimOthers && activeStepId && !active) || (hover && hover !== n.id && !connected.has(n.id));
          const done = n.stepId && reviewed[n.stepId];
          const badge = BADGE[n.change];
          return html`<g
            key=${n.id}
            class=${cx("dnode", "ch-" + n.change, "nk-" + n.kind, active && "active", dim && "dim", clickable && "clickable")}
            transform=${"translate(" + x + "," + y + ")"}
            onClick=${clickable ? () => onNodeClick(n) : null}
            onKeyDown=${clickable ? (ev) => (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), onNodeClick(n)) : null}
            onMouseEnter=${() => setHover(n.id)}
            onMouseLeave=${() => setHover(null)}
            tabindex=${clickable ? 0 : null}
            role=${clickable ? "button" : null}
            aria-label=${clickable ? n.label + ", show in the diff" : n.label}
          >
            ${active ? html`<rect class="halo" x="-3" y="-3" width=${w + 6} height=${h + 6} rx=${n.kind === "queue" ? (h + 6) / 2 : 9} />` : null}
            <rect class="nbox" width=${w} height=${h} rx=${n.kind === "queue" ? h / 2 : 6} />
            ${n.kind === "queue" ? null : html`<rect class="nbar" x="0" y="0" width="3.5" height=${h} rx="1.5" />`}
            <text class="nkind" x=${n.kind === "queue" ? 14 : 11} y="14">${KIND_TAG[n.kind] || n.kind}</text>
            ${badge && w > 104 ? html`<text class="nbadge" x=${w - (n.kind === "queue" ? 14 : 9)} y="14" text-anchor="end">${badge}</text>` : null}
            <text class="nlabel" x=${n.kind === "queue" ? 14 : 11} y="14" style=${{ fontSize: fs + "px" }}>
              ${lines.map((l, k) => html`<tspan x=${n.kind === "queue" ? 14 : 11} dy=${k === 0 ? fs * 1.55 + 3 : fs * 1.28}>${l}</tspan>`)}
            </text>
            ${done ? html`<g class="ndone" transform=${"translate(" + (w - 9) + "," + (h - 9) + ")"}><circle r="6.5" /><path d="M-3,0 L-0.8,2.4 L3.2,-2.4" /></g>` : null}
          </g>`;
        })}
      </g>
      <${EdgeLabels} edges=${lay.edges} fontSize=${fontSize} hotEdge=${hotEdge} showLabels=${showLabels} />
    </svg>
  </div>`;
}

export function Diagram(props) {
  return isFlowDiagram(props.diagram) ? html`<${FlowDiagram} ...${props} />` : html`<${ClassicDiagram} ...${props} />`;
}

export function DiagramLegend({ clickable }) {
  return html`<div class="dlegend">
    <span><i class="sw sw-added"></i>new</span>
    <span><i class="sw sw-modified"></i>changed</span>
    <span><i class="sw sw-removed"></i>removed</span>
    <span><i class="sw sw-unchanged"></i>unchanged</span>
    ${clickable ? html`<span class="hint">click a box to see it in the diff</span>` : null}
  </div>`;
}
