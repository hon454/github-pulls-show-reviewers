import { useCallback, useEffect, useState } from "react";

import { readGitHubAppConfig } from "../../src/config/github-app";
import { listAccounts, type Account } from "../../src/storage/accounts";

import { AccountsList } from "./components/AccountsList";
import { AddAccountPanel } from "./components/AddAccountPanel";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";
import { DisplaySettingsPanel } from "./components/DisplaySettingsPanel";
import { useDeviceFlowController } from "./device-flow-controller";

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

  const handleConnected = useCallback(async () => {
    setShowAddPanel(false);
    await reload();
  }, [reload]);

  // Controller is owned by the parent so it survives AddAccountPanel's
  // simulated remount under StrictMode and so start() is only ever called
  // from a user-driven click handler, never from a useEffect that
  // StrictMode double-invokes.
  const controller = useDeviceFlowController({
    clientId: appConfig?.clientId ?? "",
    onConnected: handleConnected,
  });

  const openAddPanel = () => {
    setShowAddPanel(true);
    const inFlight =
      controller.state.phase === "initiating" ||
      controller.state.phase === "waiting" ||
      controller.state.phase === "fetching_installations";
    if (!inFlight) {
      controller.start();
    }
  };

  return (
    <main className="options-page">
      <aside className="options-intro">
        <div className="brand-lockup">
          <img
            className="brand-icon"
            src="/icon/128.png"
            alt=""
            width="52"
            height="52"
          />
          <p className="eyebrow">GitHub Pulls Show Reviewers</p>
        </div>
        <h1>Reviewer context, right where you scan.</h1>
        <p className="intro-copy">
          Tune how reviewer information appears and connect GitHub only when a
          private repository needs it.
        </p>
        <div className="access-note">
          <span className="status-dot" aria-hidden="true" />
          <div>
            <strong>Public repositories are ready</strong>
            <span>No account or token required.</span>
          </div>
        </div>
        <p className="intro-footnote">
          Private access uses a GitHub App with <code>Pull requests: Read</code>
          only.
        </p>
      </aside>

      <div className="options-workspace">
        <header className="workspace-header">
          <p className="eyebrow">Extension settings</p>
          <h2>Make review status fit your workflow.</h2>
          <p>
            {appConfig
              ? "Connect accounts for private repositories, choose what appears in pull request lists, and test repository access."
              : "Account sign-in is unavailable in this build. Public repositories continue to work without signing in."}
          </p>
        </header>

        <section className="settings-section" aria-labelledby="accounts-title">
          <div className="section-heading">
            <span className="section-index">01</span>
            <div>
              <h2 id="accounts-title">GitHub accounts</h2>
              <p>
                Used only when a private repository requires authentication.
              </p>
            </div>
          </div>
          <AccountsList
            accounts={accounts}
            onChange={reload}
            onReauthenticate={() => {
              if (appConfig) {
                openAddPanel();
              }
            }}
          />
          {!appConfig ? (
            <div
              className="notice notice--error"
              data-testid="options-config-warning"
            >
              <p className="notice-title">
                GitHub sign-in is unavailable in this build.
              </p>
              <p className="notice-body">
                {configError} Reinstall a build that includes the maintainer
                GitHub App client ID and slug.
              </p>
            </div>
          ) : showAddPanel ? (
            <AddAccountPanel
              controller={controller}
              onCancel={() => setShowAddPanel(false)}
            />
          ) : (
            <button
              type="button"
              className="button button--primary add-account-button"
              onClick={openAddPanel}
              data-testid="accounts-add"
            >
              + Add another account
            </button>
          )}
        </section>

        <DisplaySettingsPanel />

        <DiagnosticsPanel />

        <section
          className="settings-section about-section"
          aria-labelledby="about-title"
        >
          <div className="section-heading">
            <span className="section-index">04</span>
            <div>
              <h2 id="about-title">About access</h2>
              <p>What the extension can read and how to revoke it.</p>
            </div>
          </div>
          <p className="about-copy">
            {appConfig ? (
              <>
                This extension signs you in through the{" "}
                <strong>{appConfig.name}</strong> GitHub App. The App requests{" "}
                <code>Pull requests: Read</code> only. Removing an account
                locally does not revoke the authorization on GitHub — manage
                revocation at{" "}
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
      </div>
    </main>
  );
}
