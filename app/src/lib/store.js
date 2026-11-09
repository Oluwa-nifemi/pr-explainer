import { useEffect, useState } from "preact/hooks";

export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...next };
      subs.forEach((f) => f());
    },
    sub(f) {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
}

export function useStore(store, select = (s) => s) {
  const [, force] = useState(0);
  useEffect(() => {
    let prev = select(store.get());
    return store.sub(() => {
      const next = select(store.get());
      if (next !== prev) {
        prev = next;
        force((n) => n + 1);
      }
    });
  }, []);
  return select(store.get());
}
