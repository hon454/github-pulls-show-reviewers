import { catalogs } from "./catalogs";
import type { Locale } from "./locale";
import type { Catalog, MessageValues, Translator } from "./messages";

/** Plain text only. Replacement values are never parsed again or treated as HTML. */
export function formatMessage(
  catalog: Catalog,
  fallback: Catalog,
  key: string,
  args: MessageValues = {},
): string {
  const entry = Object.hasOwn(catalog, key)
    ? catalog[key]
    : Object.hasOwn(fallback, key)
      ? fallback[key]
      : undefined;
  if (!entry) return key;
  return entry.message.replace(
    /\$\$|\$([a-zA-Z0-9_]+)\$/g,
    (token, name: string | undefined) => {
      if (token === "$$") return "$";
      const normalized = name!.toLowerCase();
      const placeholder = Object.entries(entry.placeholders ?? {}).find(
        ([key]) => key.toLowerCase() === normalized,
      );
      if (!placeholder || !/^\$[1-9]\d*$/.test(placeholder[1].content))
        return token;
      const value = args[normalized];
      return value === undefined ? token : String(value);
    },
  );
}

export function createTranslator(locale: Locale): Translator {
  return ((key: string, args?: MessageValues) =>
    formatMessage(catalogs[locale], catalogs.en, key, args)) as Translator;
}
