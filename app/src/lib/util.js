import { Component } from "preact";
import { html } from "htm/preact";

export const cx = (...a) => a.filter(Boolean).join(" ");

const shallowEq = (a, b) => {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
};

// Skips re-rendering when props are shallow-equal. Keeps the large diff trees quiet while chat streams.
export function memo(Comp) {
  return class Memo extends Component {
    shouldComponentUpdate(next) {
      return !shallowEq(this.props, next);
    }
    render(p) {
      return html`<${Comp} ...${p} />`;
    }
  };
}

export const fmtSec = (ms) => (ms / 1000).toFixed(1) + "s";

export const KIND_LABEL = {
  contract: "Contract",
  "core-logic": "Core logic",
  wiring: "Wiring",
  ui: "UI",
  tests: "Tests",
  config: "Config",
  refactor: "Refactor",
  docs: "Docs",
};

export const fileName = (p) => p.split("/").pop();
export const dirName = (p) => p.split("/").slice(0, -1).join("/");

// A range comment stores the first line in startLine and the last line in line (GitHub's shape).
export const isRange = (c) => c && c.startLine != null && c.startLine < c.line;
export const rangeLabel = (c) => (isRange(c) ? `lines ${c.startLine}-${c.line}` : "");

export const uid = (() => {
  let n = 0;
  return (p = "id") => p + "-" + ++n + "-" + Math.random().toString(36).slice(2, 6);
})();

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function stepNumber(story, id) {
  const s = story.steps.find((x) => x.id === id);
  return s ? s.order : null;
}

// Last two path segments, for compact labels.
export const shortPath = (p) => p.split("/").slice(-2).join("/");
