import { createTranslator } from "./formatter";
import {
  resolveLocale,
  toLanguageTag,
  type LanguagePreference,
  type Locale,
} from "./locale";
import type { Translator } from "./messages";

export interface LocaleAdapter {
  getUILanguage(): string;
  readLanguage(): Promise<LanguagePreference>;
  writeLanguage(language: LanguagePreference): Promise<void>;
  subscribe(listener: (language: LanguagePreference) => void): () => void;
}
export interface LocaleSnapshot {
  readonly language: LanguagePreference;
  readonly locale: Locale;
  readonly lang: string;
  readonly t: Translator;
}
export interface LocaleStore {
  getSnapshot(): LocaleSnapshot;
  subscribe(listener: () => void): () => void;
  ready(): Promise<void>;
  setLanguage(language: LanguagePreference): Promise<void>;
  dispose(): void;
}

/** One store per context. The first/last subscriber owns the storage listener. */
export function createLocaleStore(adapter: LocaleAdapter): LocaleStore {
  function snapshot(language: LanguagePreference): LocaleSnapshot {
    const locale = resolveLocale(
      language === "auto" ? adapter.getUILanguage() : language,
    );
    return Object.freeze({
      language,
      locale,
      lang: toLanguageTag(locale),
      t: createTranslator(locale),
    });
  }
  let current = snapshot("auto");
  const listeners = new Set<() => void>();
  let stop: (() => void) | undefined;
  let revision = 0;
  let hydration = Promise.resolve();
  let writes = Promise.resolve();
  let disposed = false;

  function publish(language: LanguagePreference) {
    const next = snapshot(language);
    if (next.language === current.language && next.locale === current.locale)
      return;
    current = next;
    for (const listener of listeners) listener();
  }
  function disconnect() {
    revision += 1;
    stop?.();
    stop = undefined;
  }

  const store: LocaleStore = {
    getSnapshot: () => current,
    subscribe(listener) {
      if (disposed) throw new Error("Locale store has been disposed");
      // Each subscription gets its own identity, even for the same callback.
      const notify = () => listener();
      listeners.add(notify);
      if (listeners.size === 1) {
        stop = adapter.subscribe((language) => {
          revision += 1;
          publish(language);
        });
        const readingAt = ++revision;
        hydration = adapter.readLanguage().then(
          (language) => {
            if (revision === readingAt) publish(language);
          },
          () => {
            if (revision === readingAt) publish("auto");
          },
        );
      }
      return () => {
        if (listeners.delete(notify) && listeners.size === 0) disconnect();
      };
    },
    async ready() {
      // Standalone DOM initialization borrows a subscription until hydration.
      const release =
        listeners.size === 0 ? store.subscribe(() => undefined) : undefined;
      try {
        await hydration;
      } finally {
        release?.();
      }
    },
    setLanguage(language) {
      if (disposed)
        return Promise.reject(new Error("Locale store has been disposed"));
      // Preserve invocation order for rapid selections; a failed write does not
      // poison later writes. Storage is the source of truth across contexts.
      const operation = writes.then(async () => {
        const writingAt = revision;
        await adapter.writeLanguage(language);
        // A storage event after this write began is newer evidence than its
        // promise completion (including an event emitted by the write itself).
        if (!disposed && revision === writingAt) {
          revision += 1;
          publish(language);
        }
      });
      writes = operation.catch(() => undefined);
      return operation;
    },
    dispose() {
      disposed = true;
      disconnect();
      listeners.clear();
    },
  };
  return store;
}
