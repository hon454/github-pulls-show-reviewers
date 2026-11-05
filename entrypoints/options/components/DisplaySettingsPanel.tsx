import { getUIClient } from "../../../src/runtime/ui-client";
import type { Translator, MessageKey } from "../../../src/i18n";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  DEFAULT_PREFERENCES,
  getPreferences,
  updatePreferences,
  type Preferences,
} from "../../../src/runtime/preferences";

export function DisplaySettingsPanel({ t }: { t: Translator }) {
  const [preferences, setPreferences] =
    useState<Preferences>(DEFAULT_PREFERENCES);
  const [busy, setBusy] = useState(false);
  // Toggles stay disabled until stored values (or a snapshot) arrive, so the
  // defaults are never presented as if they were the saved settings.
  const [loaded, setLoaded] = useState(false);
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
  const events = useRef(0);
  const active = useRef(false);

  const clearLoadFailure = useCallback(
    () =>
      setStatus((current) =>
        current?.key === "options_display_load_failed" ? null : current,
      ),
    [],
  );

  const load = useCallback(async () => {
    const readingAt = events.current;
    clearLoadFailure();
    try {
      const next = await getPreferences();
      if (active.current && events.current === readingAt) {
        setPreferences(next);
        setLoaded(true);
      }
    } catch {
      if (active.current && events.current === readingAt)
        setStatus({
          tone: "error",
          key: "options_display_load_failed",
        });
    }
  }, [clearLoadFailure]);

  useEffect(() => {
    active.current = true;
    const unsubscribe = getUIClient().subscribe(({ snapshot }) => {
      events.current += 1;
      setPreferences(snapshot.preferences);
      setLoaded(true);
      clearLoadFailure();
    });
    void load();
    return () => {
      active.current = false;
      unsubscribe();
    };
  }, [clearLoadFailure, load]);

  async function handleChange(patch: Partial<Omit<Preferences, "version">>) {
    if (busyRef.current) {
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setStatus({ tone: "neutral", key: "options_display_saving" });
    const writingAt = events.current;
    try {
      const next = await updatePreferences(patch);
      if (events.current === writingAt) setPreferences(next);
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
            disabled={!loaded}
            aria-disabled={busy || undefined}
            aria-busy={busy || undefined}
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
            disabled={!loaded}
            aria-disabled={busy || undefined}
            aria-busy={busy || undefined}
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
            disabled={!loaded}
            aria-disabled={busy || undefined}
            aria-busy={busy || undefined}
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
      {status?.key === "options_display_load_failed" ? (
        <div
          className="inline-status inline-status--error"
          role="status"
          aria-live="polite"
          data-testid="prefs-error"
        >
          <p>{t(status.key)}</p>
          <button
            type="button"
            className="button button--secondary"
            data-testid="prefs-retry"
            onClick={() => void load()}
          >
            {t("options_retry")}
          </button>
        </div>
      ) : status ? (
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
