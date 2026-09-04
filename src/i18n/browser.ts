import {
  getPreferences,
  parsePreferences,
  updatePreferences,
} from "../storage/preferences";
import { createLocaleStore, type LocaleStore } from "./store";

let store: LocaleStore | undefined;
/** Lazy browser boundary. Call once at the options/content context root. */
export function getLocaleStore(): LocaleStore {
  if (store) return store;
  const next = createLocaleStore({
    getUILanguage: () => browser.i18n.getUILanguage(),
    readLanguage: async () => (await getPreferences()).language,
    writeLanguage: async (language) => {
      await updatePreferences({ language });
    },
    subscribe(listener) {
      const onChanged: Parameters<
        typeof browser.storage.onChanged.addListener
      >[0] = (changes, area) => {
        if (area === "local" && "preferences" in changes) {
          listener(parsePreferences(changes.preferences?.newValue).language);
        }
      };
      browser.storage.onChanged.addListener(onChanged);
      return () => browser.storage.onChanged.removeListener(onChanged);
    },
  });
  const shared: LocaleStore = {
    ...next,
    dispose() {
      next.dispose();
      if (store === shared) store = undefined;
    },
  };
  store = shared;
  return store;
}
