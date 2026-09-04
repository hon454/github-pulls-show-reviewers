import type { Translator, MessageKey } from "../../../src/i18n";
import { useEffect, useRef, useState } from "react";

import {
  DEFAULT_PREFERENCES,
  getPreferences,
  updatePreferences,
  type Preferences,
} from "../../../src/storage/preferences";

export function DisplaySettingsPanel({ t }: { t: Translator }) {
  const [preferences, setPreferences] =
    useState<Preferences>(DEFAULT_PREFERENCES);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{
    tone: "neutral" | "error";
    key: Extract<
      MessageKey,
      | "options_display_load_failed"
      | "options_display_save_failed"
      | "options_display_saving"
    >;
  } | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    void (async () => {
      try {
        setPreferences(await getPreferences());
      } catch {
        setStatus({
          tone: "error",
          key: "options_display_load_failed",
        });
      }
    })();
  }, []);

  async function handleChange(patch: Partial<Omit<Preferences, "version">>) {
    if (busyRef.current) {
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setStatus({ tone: "neutral", key: "options_display_saving" });
    try {
      const next = await updatePreferences(patch);
      setPreferences(next);
      setStatus(null);
    } catch {
      setStatus({
        tone: "error",
        key: "options_display_save_failed",
      });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="settings-section" aria-labelledby="display-title">
      <div className="section-heading">
        <span className="section-index">02</span>
        <div>
          <h2 id="display-title">{t("options_display_title")}</h2>
          <p>{t("options_display_description")}</p>
        </div>
      </div>
      <div className="preference-list">
        <label className="preference-row">
          <input
            data-testid="prefs-show-state-badge"
            type="checkbox"
            checked={preferences.showStateBadge}
            disabled={busy}
            onChange={(event) =>
              void handleChange({ showStateBadge: event.target.checked })
            }
          />
          <span>
            <strong>{t("options_badges")}</strong>
            <small>{t("options_badges_description")}</small>
          </span>
        </label>
        <label className="preference-row">
          <input
            data-testid="prefs-show-reviewer-name"
            type="checkbox"
            checked={preferences.showReviewerName}
            disabled={busy}
            onChange={(event) =>
              void handleChange({ showReviewerName: event.target.checked })
            }
          />
          <span>
            <strong>{t("options_names")}</strong>
            <small>{t("options_names_description")}</small>
          </span>
        </label>
        <label className="preference-row">
          <input
            data-testid="prefs-open-pulls-only"
            type="checkbox"
            checked={preferences.openPullsOnly}
            disabled={busy}
            onChange={(event) =>
              void handleChange({ openPullsOnly: event.target.checked })
            }
          />
          <span>
            <strong>{t("options_open_only")}</strong>
            <small>{t("options_open_only_description")}</small>
          </span>
        </label>
      </div>
      {status ? (
        <p
          className={`inline-status${status.tone === "error" ? " inline-status--error" : ""}`}
          role="status"
          aria-live="polite"
          data-testid={status.tone === "error" ? "prefs-error" : "prefs-status"}
        >
          {t(status.key)}
        </p>
      ) : null}
    </section>
  );
}
