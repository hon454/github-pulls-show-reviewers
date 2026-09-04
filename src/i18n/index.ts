// Pure facade: safe in tests/data utilities without browser or React globals.
export { SUPPORTED_LOCALES, resolveLocale, toLanguageTag } from "./locale";
export type { Locale, LanguagePreference } from "./locale";
export { createTranslator, formatMessage } from "./formatter";
export type {
  MessageKey,
  MessageArgs,
  MessageValues,
  Translator,
  LocalizedMessage,
} from "./messages";
export { createLocaleStore } from "./store";
export type { LocaleStore, LocaleSnapshot, LocaleAdapter } from "./store";
