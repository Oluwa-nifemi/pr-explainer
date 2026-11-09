import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Md } from "../lib/md.js";
import { cx } from "../lib/util.js";
import { sendChat, retryChat, addDraftComment, contextChip, suggestionsFor } from "../lib/chat.js";
import { clearChat } from "../lib/api.js";
import { session, useSession, live, removeCtx, toast } from "../lib/session.js";
import { useSetup } from "../lib/setup.js";

const MODELS = {
  deepseek: { label: "DeepSeek", model: "DeepSeek V4.1 Flash", note: "Fast", hint: "Thinking low" },
  opus: { label: "Opus", model: "Claude Opus 5.5", note: "Deeper", hint: "Thinking medium, slower" },
};

const CHIP_KIND = { line: "line", hunk: "hunk", step: "step", quote: "text", question: "question" };

function Chip({ chip, onRemove }) {
  return html`<span class=${cx("ctx-chip", "t-" + chip.type)}>
    <i>${CHIP_KIND[chip.type]}</i>
    <span>${chip.label}</span>
    ${onRemove ? html`<button aria-label="Remove context" onClick=${onRemove}>×</button>` : null}
  </span>`;
}

function Lookups({ items, running }) {
  if (!items?.length) return null;
  return html`<div class="lookups">
    ${items.map((l, i) => html`<span class=${cx("lookup", running && i === items.length - 1 && "running")} key=${i} title=${l.tool}>
      ${running && i === items.length - 1 ? html`<i class="spin tiny"></i>` : html`<b>✓</b>`}
      <span>${running && i === items.length - 1 ? "looking at " : "looked at "}<code>${l.label}</code></span>
    </span>`)}
  </div>`;
}

function Draft({ msg }) {
  const d = msg.draftComment;
  const added = useSession((s) => s.addedDrafts[msg.id]);
  return html`<div class="draft-card">
    <div class="draft-head"><i>Suggested comment</i><code>${d.path.split("/").pop()}:${d.line}</code></div>
    <div class="draft-body">${d.body}</div>
    ${added
      ? html`<span class="committed">Added to your pending comments</span>`
      : html`<button class="btn small" onClick=${() => addDraftComment(msg.id, d)}>Add as review comment</button>`}
  </div>`;
}

function Label({ model }) {
  return html`<div class="ai-label"><i class="ai-mark"></i>Explainer<span class="ai-model">${MODELS[model || "deepseek"]?.model || model}</span></div>`;
}

export function ChatPanel({ story }) {
  const chat = useSession((s) => s.chat);
  const liveMsg = useSession((s) => s.chatLive);
  const error = useSession((s) => s.chatError);
  const loaded = useSession((s) => s.chatLoaded);
  const ctx = useSession((s) => s.ctx);
  const focus = useSession((s) => s.focusChat);
  const picked = useSession((s) => s.chatModel);
  const storyModel = useSetup().status?.storyModel;
  const chatModel = picked || storyModel || "deepseek";
  const text = useSession((s) => s.chatInput);
  const setText = (v) => session.set({ chatInput: v });
  const list = useRef(null);
  const ta = useRef(null);
  const isLive = !!live.prKey;
  const busy = !!liveMsg;

  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [chat, liveMsg, error]);
  useEffect(() => {
    if (focus) ta.current?.focus();
  }, [focus]);

  const send = () => {
    if (!text.trim() || busy || !isLive) return;
    sendChat(text);
    setText("");
  };
  const clear = async () => {
    if (!chat.length || busy || !confirm("Clear this chat? It is removed for this PR version.")) return;
    try {
      await clearChat(live.prKey);
      session.set({ chat: [], chatError: null, addedDrafts: {} });
    } catch (e) {
      toast(e.message, "bad");
    }
  };
  const sugg = suggestionsFor(story, ctx[0] ? ctx[0].stepId : null);

  return html`<div class="chat">
    <div class="chat-list" ref=${list}>
      ${!isLive
        ? html`<div class="chat-empty"><p class="chat-hint">Chat works on a PR opened through the service. Open one from the start page.</p></div>`
        : loaded && !chat.length && !busy
        ? html`<div class="chat-empty">
            <p class="chat-hint">Ask about the PR. Click <kbd>?</kbd> on a diff line, or "Ask about this hunk", and I will see exactly what you point at.</p>
            <p class="chat-hint small">I can read files at the PR head or base while I answer.</p>
          </div>`
        : null}
      ${chat.map((m) => {
        if (m.role === "user") {
          const chip = contextChip(m.context, story);
          return html`<div class="msg user" key=${m.id}>${chip ? html`<${Chip} chip=${chip} />` : null}<div class="bubble">${m.text}</div></div>`;
        }
        return html`<div class="msg ai" key=${m.id}>
          <${Label} model=${m.model} />
          <${Lookups} items=${m.lookups} />
          <div class="bubble"><${Md} text=${m.text} refs=${true} /></div>
          ${m.draftComment ? html`<${Draft} msg=${m} />` : null}
        </div>`;
      })}
      ${liveMsg
        ? html`<div class="msg ai">
            <${Label} model=${chatModel} />
            <${Lookups} items=${liveMsg.lookups} running=${!liveMsg.text} />
            ${liveMsg.text
              ? html`<div class="bubble streaming"><${Md} text=${liveMsg.text} refs=${true} /></div>`
              : liveMsg.lookups.length
              ? null
              : html`<div class="thinking"><i></i><i></i><i></i></div>`}
          </div>`
        : null}
      ${error
        ? html`<div class="chat-error" role="alert">
            <span>${error.message}</span>
            ${error.request ? html`<button class="btn small" onClick=${retryChat}>Retry</button>` : null}
          </div>`
        : null}
    </div>
    <div class="chat-input">
      ${!text && !busy && isLive && chat.length < 2
        ? html`<div class="sugg">${sugg.map((q) => html`<button class="sugg-btn" onClick=${() => setText(q)}>${q}</button>`)}</div>`
        : null}
      <div class="ctx-row">
        ${ctx.map((c) => html`<${Chip} chip=${c} onRemove=${() => removeCtx(c.id)} />`)}
      </div>
      <div class="input-box">
        <textarea
          ref=${ta}
          rows="2"
          value=${text}
          disabled=${!isLive}
          placeholder=${ctx.length ? "Ask about " + ctx[0].label : "Ask about this PR"}
          onInput=${(e) => setText(e.currentTarget.value)}
          onKeyDown=${(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button class="send" disabled=${!text.trim() || busy || !isLive} onClick=${send} aria-label="Send">↑</button>
      </div>
      <div class="model-row" role="radiogroup" aria-label="Model">
        ${Object.entries(MODELS).map(
          ([id, m]) => html`<button role="radio" aria-checked=${chatModel === id} class=${cx("model-opt", chatModel === id && "on")} title=${m.model + " · " + m.hint} onClick=${() => session.set({ chatModel: id })}>
            <b>${m.label}</b><span>${m.note}</span>
          </button>`
        )}
        <button class="link model-note" disabled=${!chat.length || busy} onClick=${clear}>Clear chat</button>
      </div>
    </div>
  </div>`;
}
