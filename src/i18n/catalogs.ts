import en from "../../public/_locales/en/messages.json";
import ko from "../../public/_locales/ko/messages.json";
import ja from "../../public/_locales/ja/messages.json";
import zhCN from "../../public/_locales/zh_CN/messages.json";
import zhTW from "../../public/_locales/zh_TW/messages.json";
import type { Locale } from "./locale";
import type { Catalog, MessageKey } from "./messages";

export const catalogs = {
  en,
  ko,
  ja,
  zh_CN: zhCN,
  zh_TW: zhTW,
} satisfies Record<Locale, Record<MessageKey, Catalog[string]>>;
