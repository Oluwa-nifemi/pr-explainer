import { createStore, useStore } from "./store.js";
import { getSetup } from "./api.js";

export const setup = createStore({ status: null, loaded: false, open: false });
export const useSetup = () => useStore(setup);

export async function refreshSetup() {
  try {
    setup.set({ status: await getSetup(), loaded: true });
  } catch {
    setup.set({ loaded: true });
  }
}

export const openSettings = () => setup.set({ open: true });
export const closeSettings = () => setup.set({ open: false });

if (typeof window !== "undefined") window.addEventListener("prx-setup", refreshSetup);
