import { getUIClient } from "../runtime/ui-client";
import { getPreferences, updatePreferences } from "../runtime/preferences";
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
      return getUIClient().subscribe(({ snapshot }) =>
        listener(snapshot.preferences.language),
      );
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
