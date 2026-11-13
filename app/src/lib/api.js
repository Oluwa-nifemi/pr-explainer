import { prepareStory } from "./prepare.js";

export const API = "http://127.0.0.1:5190";

export class ApiError extends Error {
  constructor(status, code, message, data) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

async function call(method, path, body) {
  let r;
  try {
    r = await fetch(API + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "service_down", "The PR Explainer service is not running on " + API + ".");
  }
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const e = data?.error || {};
    if (r.status === 428) window.dispatchEvent(new Event("prx-setup"));
    throw new ApiError(r.status, e.code || "error", e.message || r.statusText, data);
  }
  return data;
}

export const getSetup = () => call("GET", "/api/setup");
export const saveSetup = (body) => call("POST", "/api/setup", body);
export const clearSetup = () => call("DELETE", "/api/setup");

export const getChat = (key) => call("GET", prPath(key) + "/chat");
export const clearChat = (key) => call("DELETE", prPath(key) + "/chat");

export async function streamChat(key, request, onEvent, signal) {
  let r;
  try {
    r = await fetch(API + prPath(key) + "/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new ApiError(0, "service_down", "The PR Explainer service is not running on " + API + ".");
  }
  if (!r.ok) {
    const data = await r.json().catch(() => null);
    const e = data?.error || {};
    if (r.status === 428) window.dispatchEvent(new Event("prx-setup"));
    throw new ApiError(r.status, e.code || "error", e.message || r.statusText, data);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const flush = (block) => {
    let type = "message";
    const lines = [];
    for (const l of block.split("\n")) {
      if (l.startsWith("event:")) type = l.slice(6).trim();
      else if (l.startsWith("data:")) lines.push(l.slice(5).replace(/^ /, ""));
    }
    if (!lines.length) return;
    try {
      onEvent(type, JSON.parse(lines.join("\n")));
    } catch {}
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      flush(buf.slice(0, i));
      buf = buf.slice(i + 2);
    }
  }
  if (buf.trim()) flush(buf);
}

export const prPath = (key) => "/api/prs/" + key;
export const exportUrl = (key) => API + prPath(key) + "/export";
export const keyOf = (owner, repo, number) => owner + "/" + repo + "/" + number;
export const urlOf = (key) => "https://github.com/" + key.replace(/\/(\d+)$/, "/pull/$1");

export const listPrs = () => call("GET", "/api/prs");
export const regeneratePr = (key) => call("POST", prPath(key) + "/regenerate");
export const retryStep = (key, id) => call("POST", prPath(key) + "/steps/" + id + "/retry");
export const startPr = (key) => call("POST", "/api/prs", { url: urlOf(key) });
export const getThreads = (key, refresh) => call("GET", prPath(key) + "/threads" + (refresh ? "?refresh=1" : ""));
export const getFile = (key, path, at = "head") => call("GET", prPath(key) + "/file?path=" + encodeURIComponent(path) + "&at=" + at);
export const postReview = (key, review) => call("POST", prPath(key) + "/reviews", review);
export const replyThread = (id, body) => call("POST", "/api/threads/" + encodeURIComponent(id) + "/replies", { body });
export const setReaction = (id, content, on) => call("POST", "/api/comments/" + encodeURIComponent(id) + "/reactions", { content, on });
export const getSettings = () => call("GET", "/api/settings");
export const saveSettings = (body) => call("PUT", "/api/settings", body);
export const setResolved = (id, resolved) => call("POST", "/api/threads/" + encodeURIComponent(id) + (resolved ? "/resolve" : "/unresolve"));

export async function getStory(key) {
  try {
    return adaptStory(await call("GET", prPath(key) + "/story"));
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

export function adaptStory(story) {
  if (!story) return null;
  return prepareStory(story);
}

const EVENTS = ["story", "summary", "plan", "step", "overview", "done", "threads", "error"];

export function openEvents(key, onEvent) {
  const es = new EventSource(API + prPath(key) + "/events");
  EVENTS.forEach((type) =>
    es.addEventListener(type, (e) => {
      let data = null;
      try {
        data = JSON.parse(e.data);
      } catch {}
      onEvent(type, data);
    })
  );
  return () => es.close();
}
