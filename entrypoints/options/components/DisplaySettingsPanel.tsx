import { useEffect, useState, type CSSProperties } from "react";

import {
  DEFAULT_PREFERENCES,
  getPreferences,
  updatePreferences,
  type Preferences,
} from "../../../src/storage/preferences";

export function DisplaySettingsPanel() {
  const [preferences, setPreferences] =
    useState<Preferences>(DEFAULT_PREFERENCES);

  useEffect(() => {
    void (async () => {
      setPreferences(await getPreferences());
    })();
  }, []);

  async function handleChange(patch: Partial<Omit<Preferences, "version">>) {
    const next = await updatePreferences(patch);
    setPreferences(next);
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
          onChange={(event) =>
            handleChange({ showStateBadge: event.target.checked })
          }
        />
        <span>Show review state badge on avatars</span>
      </label>
      <label style={styles.row}>
        <input
          data-testid="prefs-show-reviewer-name"
          type="checkbox"
          checked={preferences.showReviewerName}
          onChange={(event) =>
            handleChange({ showReviewerName: event.target.checked })
          }
        />
        <span>Show reviewer names</span>
      </label>
      <label style={styles.row}>
        <input
          data-testid="prefs-open-pulls-only"
          type="checkbox"
          checked={preferences.openPullsOnly}
          onChange={(event) =>
            handleChange({ openPullsOnly: event.target.checked })
          }
        />
        <span>Open pull requests only in reviewer links</span>
      </label>
    </section>
  );
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
};
