import { useRef, useState } from "react";
import type {
  LanguagePreference,
  LocaleSnapshot,
  LocaleStore,
  MessageKey,
} from "../../../src/i18n";

const choices = [
  ["auto", "language_auto"],
  ["en", "language_en"],
  ["ko", "language_ko"],
  ["ja", "language_ja"],
  ["zh_CN", "language_zh_cn"],
  ["zh_TW", "language_zh_tw"],
] as const satisfies readonly (readonly [LanguagePreference, MessageKey])[];

export function LanguageSelector({
  store,
  locale,
}: {
  store: LocaleStore;
  locale: LocaleSnapshot;
}) {
  const [status, setStatus] = useState<"saving" | "saved" | "failed" | null>(
    null,
  );
  const busy = useRef(false);
  async function select(language: LanguagePreference) {
    if (busy.current) return;
    busy.current = true;
    setStatus("saving");
    try {
      await store.setLanguage(language);
      setStatus("saved");
    } catch {
      setStatus("failed");
    } finally {
      busy.current = false;
    }
  }
  const { t } = locale;
  return (
    <div className="language-settings">
      <label htmlFor="language-select">{t("language_label")}</label>
      <select
        id="language-select"
        data-testid="language-select"
        value={locale.language}
        disabled={status === "saving"}
        aria-describedby="language-help language-status"
        onChange={(event) =>
          void select(event.target.value as LanguagePreference)
        }
      >
        {choices.map(([value, key]) => (
          <option key={value} value={value}>
            {t(key)}
          </option>
        ))}
      </select>
      <p id="language-help">{t("language_help")}</p>
      <p
        id="language-status"
        role="status"
        aria-live="polite"
        className={status === "failed" ? "inline-status--error" : ""}
      >
        {status
          ? t(
              status === "saving"
                ? "language_saving"
                : status === "saved"
                  ? "language_saved"
                  : "language_save_failed",
            )
          : ""}
      </p>
    </div>
  );
}
