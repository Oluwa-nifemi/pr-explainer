import { html } from "htm/preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Entry } from "./Entry.js";
import { Header, ReviewDialog, ExpandModal, Toast } from "./Chrome.js";
import { Overview } from "./Overview.js";
import { Walkthrough } from "./Walkthrough.js";
import { Aside } from "./Aside.js";
import { Setup } from "./Setup.js";
import { SettingsPage } from "./Settings.js";
import { loadStory, refetchStory } from "../lib/loader.js";
import { useSetup, refreshSetup } from "../lib/setup.js";
import { loadChat, abortChat } from "../lib/chat.js";
import { makeTimeline, partialStory, hasSeen, markSeen } from "../lib/generation.js";
import { session, useSession, live, resetSession, goStep, moveStep, toggleReviewed, reviewAndNext, openChat, showOverview, hydrateViewed, hydrateDrafts, toast } from "../lib/session.js";
import { startPr, getStory, getThreads, openEvents, regeneratePr } from "../lib/api.js";

const read = () => {
  const p = new URLSearchParams(location.search);
  return { story: p.get("story"), pr: p.get("pr"), settings: p.get("settings"), instant: p.get("instant") === "1", fresh: p.get("fresh") === "1" };
};

export function navigate(search) {
  history.pushState(null, "", location.pathname + (search || ""));
  window.dispatchEvent(new Event("prx-nav"));
  window.scrollTo(0, 0);
}

function useRoute() {
  const [r, setR] = useState(read());
  useEffect(() => {
    const f = () => setR(read());
    window.addEventListener("popstate", f);
    window.addEventListener("prx-nav", f);
    return () => {
      window.removeEventListener("popstate", f);
      window.removeEventListener("prx-nav", f);
    };
  }, []);
  return r;
}

export function App() {
  const route = useRoute();
  const st = useSetup();
  useEffect(() => {
    refreshSetup();
  }, []);
  const notReady = !!(st.status && !st.status.ready);
  useEffect(() => {
    if (!notReady) return;
    const id = setInterval(refreshSetup, 3000);
    return () => clearInterval(id);
  }, [notReady]);
  if (!st.loaded) return html`<div class="boot"><i class="spin"></i></div>`;
  if (st.status && !st.status.ready) return html`<${Setup} status=${st.status} />`;
  const page = route.settings !== null
    ? html`<${SettingsPage} tab=${route.settings} go=${navigate} />`
    : route.pr
    ? html`<${LivePage} key=${route.pr} prKey=${route.pr} />`
    : !route.story
    ? html`<${Entry} go=${(name) => navigate("?story=" + encodeURIComponent(name))} goPr=${(key) => navigate("?pr=" + key)} goSettings=${() => navigate("?settings=pipeline")} />`
    : html`<${StoryPage} key=${route.story} route=${route} />`;
  return html`${page}${st.open && st.status ? html`<${Setup} status=${st.status} modal=${true} />` : null}`;
}

function useKeys() {
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target.closest?.("input,textarea,select,[contenteditable],.modal")) return;
      const s = session.get();
      if (s.review.open || s.expandDiagram) return;
      const st = live.story;
      if (!st) return;
      if (e.key === "j" || e.key === "ArrowRight") (e.preventDefault(), moveStep(st, 1));
      else if (e.key === "k" || e.key === "ArrowLeft") (e.preventDefault(), moveStep(st, -1));
      else if (e.key === "r" && s.view === "walk" && s.current) reviewAndNext(st);
      else if (e.key === "c") (e.preventDefault(), openChat());
      else if (e.key === "o") showOverview();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

// A real PR from the local service: the story streams in over server-sent events.
function LivePage({ prKey }) {
  const [story, setStory] = useState(null);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());
  const pending = useRef(null);
  const restored = useRef(false);

  useEffect(() => {
    let dead = false;
    resetSession();
    live.prKey = prKey;
    const apply = (s) => {
      if (dead || !s) return;
      setStory(s);
      syncEvents(s);
      const cur = session.get().current;
      if (!cur || !s.steps.some((x) => x.id === cur)) session.set({ current: s.steps[0]?.id || null });
      if (!restored.current && s.steps.length) {
        restored.current = true;
        const h = location.hash.slice(1);
        if (h && s.steps.some((x) => x.id === h)) {
          session.set({ view: "walk", current: h });
          setTimeout(() => goStep(h, { smooth: false }), 150);
          setTimeout(() => goStep(h, { smooth: false }), 700);
        }
      }
    };
    const refetch = () => {
      if (pending.current) return;
      pending.current = setTimeout(async () => {
        pending.current = null;
        try {
          apply(await getStory(prKey));
        } catch (e) {
          if (!dead) setError(e.message);
        }
      }, 150);
    };
    const loadThreads = (refresh) => getThreads(prKey, refresh).then((t) => !dead && session.set({ threads: t })).catch(() => {});
    let stream = null;
    let close = () => stream?.();
    const onEvent = (type, data) => {
      if (type === "threads") return data && session.set({ threads: data });
      if (type === "error") setError(data?.message || "Generation failed");
      refetch();
      if (type === "done") loadThreads(false);
    };
    const syncEvents = (st) => {
      const busy = st && (st.regenerating || !["done", "failed"].includes(st.generation?.status));
      if (busy && !stream) stream = openEvents(prKey, onEvent);
      else if (!busy && stream) {
        stream();
        stream = null;
      }
    };
    let lastFocus = Date.now();
    const onFocus = () => {
      if (Date.now() - lastFocus < 60000) return;
      lastFocus = Date.now();
      loadThreads(true);
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("prx-regen", refetch);
    const waitForStory = async () => {
      for (let i = 0; i < 75 && !dead; i++) {
        try {
          const saved = await getStory(prKey);
          if (saved) return apply(saved);
        } catch (e) {
          return !dead && setError(e.message);
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      if (!dead) setError("The story did not start. Check that the service can reach GitHub.");
    };
    getStory(prKey).then((saved) => !dead && apply(saved)).catch(() => {});
    startPr(prKey)
      .then(() => {
        if (dead) return;
        waitForStory();
        loadThreads(false);
        loadChat(prKey);
      })
      .catch((e) => !dead && setError(e.message));
    return () => {
      dead = true;
      close();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("prx-regen", refetch);
      abortChat();
      live.story = null;
      live.prKey = null;
    };
  }, [prKey]);

  const generating = story && !["done", "failed"].includes(story.generation.status);
  useEffect(() => {
    if (!generating) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [generating]);
  useKeys();

  useEffect(() => {
    const t = story?.pr?.title;
    document.title = t ? t + " · PR Explainer" : "PR Explainer";
    return () => {
      document.title = "PR Explainer";
    };
  }, [story?.pr?.title]);

  useEffect(() => {
    if (story) {
      hydrateViewed(story);
      hydrateDrafts(story);
    }
  }, [story]);

  if (story) live.story = story;
  if (!story)
    return error
      ? html`<main class="entry"><div class="entry-wrap"><h1>Could not open ${prKey}.</h1><p class="entry-lede">${error}</p><button class="btn primary" onClick=${() => navigate("")}>Back to start</button></div></main>`
      : html`<div class="boot"><i class="spin"></i><p class="muted">Starting ${prKey}</p></div>`;
  const elapsed = generating ? Math.max(0, now - Date.parse(story.generation.startedAt)) : story.generation.timings?.totalMs || 0;
  return html`<div class="app"><${Shell} story=${story} elapsed=${elapsed} simulated=${false} /></div>`;
}

function Missing({ name }) {
  return html`<main class="entry"><div class="entry-wrap">
    <h1>Could not load that story.</h1>
    <p class="entry-lede">Nothing at <code>${name}</code> looks like a PR story file.</p>
    <button class="btn primary" onClick=${() => navigate("")}>Back to start</button>
  </div></main>`;
}

function StoryPage({ route }) {
  const [loaded, setLoaded] = useState({ status: "loading" });
  const [full, setFull] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const sim = useRef(false);

  useEffect(() => {
    let dead = false;
    resetSession();
    loadStory(route.story).then((r) => {
      if (dead) return;
      if (!r) return setLoaded({ status: "missing" });
      const simulate = !route.instant && (route.fresh || !hasSeen(r.name)) && r.story.generation.status === "done";
      sim.current = simulate;
      if (simulate) markSeen(r.name);
      setFull(r.story);
      setLoaded({ status: "ready", name: r.name, spec: r.spec });
      const h = location.hash.slice(1);
      if (h && r.story.steps.some((s) => s.id === h)) {
        session.set({ view: "walk", current: h });
        if (!simulate) setTimeout(() => goStep(h, { smooth: false }), 80);
      } else {
        session.set({ view: "overview", current: r.story.steps[0]?.id || null });
      }
    });
    return () => {
      dead = true;
      live.story = null;
    };
  }, [route.story]);

  // simulated streaming clock
  const tl = useMemo(() => (full ? makeTimeline(full) : null), [full]);
  useEffect(() => {
    if (!full || !sim.current) return;
    const t0 = Date.now();
    const id = setInterval(() => {
      const ms = Date.now() - t0;
      setElapsed(ms);
      if (ms > tl.doneAt + 1500) clearInterval(id);
    }, 100);
    return () => clearInterval(id);
  }, [full]);

  // pipeline stories that are still being written: poll the file
  useEffect(() => {
    if (!full || sim.current || ["done", "failed"].includes(full.generation.status)) return;
    const started = Date.parse(full.generation.startedAt);
    const id = setInterval(async () => {
      setElapsed(Math.max(0, Date.now() - started));
      const next = await refetchStory(loaded.spec);
      if (next) setFull(next);
    }, 2000);
    return () => clearInterval(id);
  }, [full && full.generation.status]);

  const story = useMemo(() => {
    if (!full) return null;
    return sim.current && tl && elapsed < tl.doneAt ? partialStory(full, elapsed, tl) : full;
  }, [full, elapsed, tl]);
  if (story) live.story = story;

  const current = useSession((s) => s.current);
  useEffect(() => {
    if (story && !current && story.steps.length) session.set({ current: story.steps[0].id });
  }, [story && story.steps.length]);

  // keyboard
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target.closest?.("input,textarea,select,[contenteditable],.modal")) return;
      const s = session.get();
      if (s.review.open || s.expandDiagram) return;
      const st = live.story;
      if (!st) return;
      if (e.key === "j" || e.key === "ArrowRight") (e.preventDefault(), moveStep(st, 1));
      else if (e.key === "k" || e.key === "ArrowLeft") (e.preventDefault(), moveStep(st, -1));
      else if (e.key === "r" && s.view === "walk" && s.current) reviewAndNext(st);
      else if (e.key === "c") (e.preventDefault(), openChat());
      else if (e.key === "o") showOverview();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (loaded.status === "loading" || !story) return loaded.status === "missing" ? html`<${Missing} name=${route.story} />` : html`<div class="boot"><i class="spin"></i></div>`;

  return html`<div class="app"><${Shell} story=${story} elapsed=${elapsed} simulated=${sim.current} /></div>`;
}

function OutdatedBanner({ story }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!story.outdated) setBusy(false);
  }, [story.outdated]);
  if (!story.outdated && !story.regenerating) return null;
  const running = busy || story.regenerating;
  const go = async () => {
    setBusy(true);
    try {
      await regeneratePr(live.prKey);
      window.dispatchEvent(new Event("prx-regen"));
    } catch (e) {
      setBusy(false);
      toast(e.message, "bad");
    }
  };
  return html`<div class="outdated-banner">
    <span>${running ? "Regenerating with the current pipeline. You can keep reading this version." : "Made with an older version of the pipeline."}</span>
    ${running ? html`<i class="spin tiny"></i>` : html`<button class="btn small" onClick=${go}>Regenerate</button>`}
  </div>`;
}

function Shell({ story, elapsed, simulated }) {
  const view = useSession((s) => s.view);
  const asideOpen = useSession((s) => s.asideOpen);
  return html`
    <${Header} story=${story} elapsed=${elapsed} simulated=${simulated} navigateHome=${() => navigate("")} />
    <${OutdatedBanner} story=${story} />
    ${view === "walk"
      ? html`<div class="walk"><${Walkthrough} story=${story} /><${Aside} story=${story} mode="walk" /></div>`
      : html`<div class=${"ovl" + (asideOpen ? " with-aside" : "")}><main class="ov-main"><${Overview} story=${story} /></main>${asideOpen ? html`<${Aside} story=${story} mode="overview" />` : null}</div>`}
    <${ReviewDialog} story=${story} />
    <${ExpandModal} />
    <${Toast} />`;
}
