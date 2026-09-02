import { useEffect, useRef, useState } from "react";

import {
  DEFAULT_PREFERENCES,
  getPreferences,
  updatePreferences,
  type Preferences,
} from "../../../src/storage/preferences";

export function DisplaySettingsPanel() {
  const [preferences, setPreferences] =
    useState<Preferences>(DEFAULT_PREFERENCES);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{
    tone: "neutral" | "error";
    message: string;
  } | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    void (async () => {
      try {
        setPreferences(await getPreferences());
      } catch (error) {
        setStatus({
          tone: "error",
          message: `Could not load display settings. ${errorMessage(error)}`,
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
    setStatus({ tone: "neutral", message: "Saving display settings..." });
    try {
      const next = await updatePreferences(patch);
      setPreferences(next);
      setStatus(null);
    } catch (error) {
      setStatus({
        tone: "error",
        message: `Could not save display settings. ${errorMessage(error)}`,
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
          <h2 id="display-title">Display</h2>
          <p>Control how reviewer chips look on GitHub pull request lists.</p>
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
            <strong>Review state badges</strong>
            <small>Show approval and request state directly on avatars.</small>
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
            <strong>Reviewer names</strong>
            <small>Keep names visible next to reviewer avatars.</small>
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
            <strong>Open pull requests only</strong>
            <small>Limit reviewer links to work that is still open.</small>
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
          {status.message}
        </p>
      ) : null}
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Please try again.";
}
