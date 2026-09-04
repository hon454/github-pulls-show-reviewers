export const SUPPORTED_LOCALES = ["en", "ko", "ja", "zh_CN", "zh_TW"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export type LanguagePreference = "auto" | Locale;

export function resolveLocale(input: string): Locale {
  const [language, ...subtags] = input
    .trim()
    .toLowerCase()
    .replaceAll("_", "-")
    .split("-");
  if (language === "en" || language === "ko" || language === "ja")
    return language;
  if (language !== "zh") return "en";
  if (subtags.includes("hans")) return "zh_CN";
  if (subtags.includes("hant")) return "zh_TW";
  return subtags.some((tag) => ["tw", "hk", "mo"].includes(tag))
    ? "zh_TW"
    : "zh_CN";
}

export function toLanguageTag(locale: Locale): string {
  return locale.replace("_", "-");
}
