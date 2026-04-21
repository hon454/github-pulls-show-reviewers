import { useCallback, useEffect, useState, type CSSProperties } from "react";

import { readGitHubAppConfig } from "../../src/config/github-app";
import { listAccounts, type Account } from "../../src/storage/accounts";

import { AccountsList } from "./components/AccountsList";
import { AddAccountPanel } from "./components/AddAccountPanel";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";

export function OptionsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [showAddPanel, setShowAddPanel] = useState(false);
  const appConfigResult = readGitHubAppConfig();
  const appConfig = appConfigResult.ok ? appConfigResult.config : null;
  const configError = appConfigResult.ok ? null : appConfigResult.message;

  const reload = useCallback(async () => {
    setAccounts(await listAccounts());
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <main style={styles.page}>
      <section style={styles.card}>
        <p style={styles.eyebrow}>GitHub Pulls Show Reviewers</p>
        <h1 style={styles.title}>Reviewer visibility for GitHub pull request lists</h1>
        <p style={styles.body}>
          {appConfig
            ? "Sign in with GitHub (via our GitHub App) to see reviewer chips on private-repository pull request lists. Public repositories continue to work without signing in. For organization-owned private repositories, an organization owner may need to install the GitHub App first."
            : "This build is missing its GitHub App configuration, so account sign-in is unavailable. Public repositories continue to work without signing in."}
        </p>

        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>GitHub accounts</h2>
          <AccountsList
            accounts={accounts}
            onChange={reload}
            onReauthenticate={() => {
              if (appConfig) {
                setShowAddPanel(true);
              }
            }}
          />
          {!appConfig ? (
            <div style={styles.warning} data-testid="options-config-warning">
              <p style={styles.warningTitle}>GitHub sign-in is unavailable in this build.</p>
              <p style={styles.warningBody}>
                {configError} Reinstall a build that includes the maintainer
                GitHub App client ID and slug.
              </p>
            </div>
          ) : showAddPanel ? (
            <AddAccountPanel
              onConnected={async () => {
                setShowAddPanel(false);
                await reload();
              }}
            />
          ) : (
            <button
              type="button"
              style={styles.primaryButton}
              onClick={() => setShowAddPanel(true)}
              data-testid="accounts-add"
            >
              + Add another account
            </button>
          )}
        </section>

        <DiagnosticsPanel />

        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>About</h2>
          <p style={styles.hint}>
            {appConfig ? (
              <>
                This extension signs you in through the{" "}
                <strong>{appConfig.name}</strong> GitHub App. The App requests{" "}
                <code>Pull requests: Read</code> only. Removing an account locally
                does not revoke the authorization on GitHub — manage revocation at{" "}
                <a
                  href="https://github.com/settings/applications"
                  target="_blank"
                  rel="noreferrer"
                >
                  github.com/settings/applications
                </a>
                .
              </>
            ) : (
              <>GitHub App metadata could not be loaded from this build.</>
            )}
          </p>
        </section>
      </section>
    </main>
  );
}

const styles: Record<string, CSSProperties> = {
  page: {
    minHeight: "100vh",
    margin: 0,
    padding: "40px 24px",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    background:
      "radial-gradient(circle at top left, rgba(255, 214, 102, 0.45), transparent 32%), #f4efe6",
    color: "#221d18",
  },
  card: {
    maxWidth: 720,
    margin: "0 auto",
    padding: 32,
    borderRadius: 20,
    background: "rgba(255, 255, 255, 0.82)",
    boxShadow: "0 18px 60px rgba(34, 29, 24, 0.12)",
    border: "1px solid rgba(34, 29, 24, 0.08)",
  },
  section: {
    marginTop: 32,
    paddingTop: 24,
    borderTop: "1px solid rgba(34, 29, 24, 0.08)",
  },
  sectionTitle: { margin: 0, fontSize: 20 },
  eyebrow: {
    margin: 0,
    textTransform: "uppercase",
    letterSpacing: "0.12em",
    fontSize: 12,
    color: "#9f5a14",
    fontWeight: 700,
  },
  title: { margin: "12px 0 16px", fontSize: 36, lineHeight: 1.1 },
  body: { margin: 0, maxWidth: 560, color: "#52463b", lineHeight: 1.6 },
  hint: { color: "#6e5f52", fontSize: 13, lineHeight: 1.6 },
  warning: {
    marginTop: 12,
    padding: 16,
    borderRadius: 16,
    background: "#fff4f4",
    border: "1px solid rgba(207, 34, 46, 0.18)",
  },
  warningTitle: { margin: 0, color: "#cf222e", fontWeight: 700 },
  warningBody: { margin: "8px 0 0", color: "#6e5f52", lineHeight: 1.6 },
  primaryButton: {
    marginTop: 12,
    border: 0,
    borderRadius: 999,
    padding: "12px 18px",
    background: "#1f6feb",
    color: "white",
    fontWeight: 700,
    cursor: "pointer",
  },
};
