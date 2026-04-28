import { useEffect, useRef, useState, type CSSProperties } from "react";

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
    <section style={styles.section}>
      <h2 style={styles.sectionTitle}>Display</h2>
      <p style={styles.hint}>
        Control how reviewer chips look on GitHub pull request lists.
      </p>
      <label style={styles.row}>
        <input
          data-testid="prefs-show-state-badge"
          type="checkbox"
          checked={preferences.showStateBadge}
          disabled={busy}
          onChange={(event) =>
            void handleChange({ showStateBadge: event.target.checked })
          }
        />
        <span>Show review state badge on avatars</span>
      </label>
      <label style={styles.row}>
        <input
          data-testid="prefs-show-reviewer-name"
          type="checkbox"
          checked={preferences.showReviewerName}
          disabled={busy}
          onChange={(event) =>
            void handleChange({ showReviewerName: event.target.checked })
          }
        />
        <span>Show reviewer names</span>
      </label>
      <label style={styles.row}>
        <input
          data-testid="prefs-open-pulls-only"
          type="checkbox"
          checked={preferences.openPullsOnly}
          disabled={busy}
          onChange={(event) =>
            void handleChange({ openPullsOnly: event.target.checked })
          }
        />
        <span>Open pull requests only in reviewer links</span>
      </label>
      {status ? (
        <p
          style={{
            ...styles.status,
            color: status.tone === "error" ? "#cf222e" : "#52463b",
          }}
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

const styles: Record<string, CSSProperties> = {
  section: {
    marginTop: 32,
    paddingTop: 24,
    borderTop: "1px solid rgba(34, 29, 24, 0.08)",
  },
  sectionTitle: { margin: 0, fontSize: 20 },
  hint: {
    color: "#6e5f52",
    fontSize: 13,
    lineHeight: 1.6,
    margin: "8px 0 12px",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 0",
    fontSize: 14,
    color: "#221d18",
    cursor: "pointer",
  },
  status: {
    margin: "8px 0 0",
    fontSize: 13,
    lineHeight: 1.5,
  },
};
