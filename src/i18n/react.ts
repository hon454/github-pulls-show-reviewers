import { useSyncExternalStore } from "react";
import type { LocaleSnapshot, LocaleStore } from "./store";

/** Inject the context-owned store; React subscription cleanup releases it. */
export function useLocale(store: LocaleStore): LocaleSnapshot {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}
