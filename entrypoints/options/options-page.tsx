import { useCallback, useEffect, useRef, useState } from "react";

import { getLocaleStore } from "../../src/i18n/browser";
import { useLocale } from "../../src/i18n/react";
import type { LocaleStore } from "../../src/i18n";
import { LanguageSelector } from "./components/LanguageSelector";

import { readGitHubAppConfig } from "../../src/config/github-app";
import { listAccounts } from "../../src/runtime/accounts";
import { getUIClient } from "../../src/runtime/ui-client";
import type { AccountSummary as Account } from "../../src/runtime/ui-contract";

import { AccountsList } from "./components/AccountsList";
import { AddAccountPanel } from "./components/AddAccountPanel";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";
import { DisplaySettingsPanel } from "./components/DisplaySettingsPanel";
import { useDeviceFlowController } from "./device-flow-controller";

export function OptionsPage({
  localeStore = getLocaleStore(),
}: {
  localeStore?: LocaleStore;
}) {
  const locale = useLocale(localeStore);
  const { t } = locale;
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    document.documentElement.lang = locale.lang;
    document.title = t("options_title");
  }, [locale.lang, t]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<"connected" | null>(
    null,
  );
  const [focusRestorationIntent, setFocusRestorationIntent] = useState<
    number | null
  >(null);
  const accountsRevision = useRef(0);
  const addAccountButton = useRef<HTMLButtonElement | null>(null);
  const openingControl = useRef<HTMLElement | null>(null);
  const addAccountPanel = useRef<HTMLDivElement | null>(null);
  const panelFocusOwned = useRef(false);
  const focusIntentGeneration = useRef(0);
  const appConfigResult = readGitHubAppConfig();
  const appConfig = appConfigResult.ok ? appConfigResult.config : null;

  useEffect(() => {
    const relinquishPanelFocus = (target: EventTarget | null) => {
      if (
        !(target instanceof Node) ||
        addAccountPanel.current?.contains(target)
      )
        return;
      panelFocusOwned.current = false;
      focusIntentGeneration.current += 1;
    };
    const handleFocusIn = (event: FocusEvent) =>
      relinquishPanelFocus(event.target);
    const handlePointerDown = (event: PointerEvent) =>
      relinquishPanelFocus(event.target);
    // When a focused waiting child is removed, browsers can move focus to
    // body without another focus event. Listen for the next external intent
    // so stale ownership cannot reclaim focus on completion.
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, []);

  const reload = useCallback(async () => {
    const readingAt = ++accountsRevision.current;
    try {
      const next = await listAccounts();
      if (accountsRevision.current !== readingAt) return;
      setAccounts(next);
      setLoadFailed(false);
    } catch {
      if (accountsRevision.current === readingAt) setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = getUIClient().subscribe(({ snapshot }) => {
      if (snapshot.accounts) {
        accountsRevision.current += 1;
        setAccounts(snapshot.accounts);
        setLoadFailed(false);
      }
    });
    void reload();
    return () => {
      accountsRevision.current += 1;
      unsubscribe();
    };
  }, [reload]);

  const restoreOpeningFocus = useCallback(() => {
    setFocusRestorationIntent(focusIntentGeneration.current);
  }, []);

  useEffect(() => {
    if (showAddPanel || focusRestorationIntent === null) return;
    if (focusIntentGeneration.current === focusRestorationIntent && (
      document.activeElement === document.body ||
      !document.activeElement?.isConnected
    )) {
      const target = openingControl.current;
      (target?.isConnected ? target : addAccountButton.current)?.focus();
    }
    setFocusRestorationIntent(null);
  }, [focusRestorationIntent, showAddPanel]);

  const handleConnected = useCallback(async () => {
    // The focused waiting control can be removed while the flow fetches and
    // commits account data. Preserve ownership captured while that control was
    // live; intentional focus moving out of the panel clears it.
    const shouldRestoreFocus = panelFocusOwned.current;
    panelFocusOwned.current = false;
    setConnectionStatus("connected");
    setShowAddPanel(false);
    if (shouldRestoreFocus) restoreOpeningFocus();
    await reload();
  }, [reload, restoreOpeningFocus]);

  // Controller is owned by the parent so it survives AddAccountPanel's
  // simulated remount under StrictMode and so start() is only ever called
  // from a user-driven click handler, never from a useEffect that
  // StrictMode double-invokes.
  const controller = useDeviceFlowController({
    onConnected: handleConnected,
  });

  const openAddPanel = (control: HTMLElement) => {
    openingControl.current = control;
    panelFocusOwned.current = false;
    setConnectionStatus(null);
    setFocusRestorationIntent(null);
    setShowAddPanel(true);
    const inFlight =
      controller.state.phase === "initiating" ||
      controller.state.phase === "waiting" ||
      controller.state.phase === "fetching_installations" ||
      controller.state.phase === "committing" ||
      controller.state.phase === "cancelling";
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
        <h1>{t("options_heading")}</h1>
        <p className="intro-copy">{t("options_intro")}</p>
        <div className="access-note">
          <span className="status-dot" aria-hidden="true" />
          <div>
            <strong>{t("options_public_ready")}</strong>
            <span>{t("options_no_account")}</span>
          </div>
        </div>
        <p className="intro-footnote">
          {t("options_private_permission", {
            permission: "Pull requests: Read",
          })}
        </p>
      </aside>

      <div className="options-workspace">
        <header className="workspace-header">
          <p className="eyebrow">{t("options_settings")}</p>
          <h2>{t("options_workspace_heading")}</h2>
          <p>
            {appConfig
              ? t("options_workspace_description")
              : t("options_signin_unavailable_description")}
          </p>
          <LanguageSelector store={localeStore} locale={locale} />
        </header>

        <section className="settings-section" aria-labelledby="accounts-title">
          <div className="section-heading">
            <span className="section-index">01</span>
            <div>
              <h2 id="accounts-title">{t("options_accounts_title")}</h2>
              <p>{t("options_accounts_description")}</p>
            </div>
          </div>
          {loadFailed ? (
            <div
              role="status"
              aria-live="polite"
              className="inline-status inline-status--error"
            >
              <p>{t("options_accounts_load_failed")}</p>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => void reload()}
              >
                {t("options_retry")}
              </button>
            </div>
          ) : null}
          <AccountsList
            t={t}
            accounts={accounts}
            onChange={reload}
            onReauthenticate={(_, control) => {
              if (appConfig) {
                openAddPanel(control);
              }
            }}
          />
          {connectionStatus === "connected" ? (
            <p
              className="inline-status"
              data-testid="account-connected-status"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {t("options_account_connected")}
            </p>
          ) : null}
          {!appConfig ? (
            <div
              className="notice notice--error"
              data-testid="options-config-warning"
            >
              <p className="notice-title">{t("options_config_title")}</p>
              <p className="notice-body">{t("options_config_guidance")}</p>
            </div>
          ) : showAddPanel ? (
            <AddAccountPanel
              locale={locale}
              controller={controller}
              panelRef={addAccountPanel}
              onFocusOwnershipChange={(owned) => {
                panelFocusOwned.current = owned;
              }}
              onCancel={(shouldRestoreFocus) => {
                panelFocusOwned.current = false;
                setShowAddPanel(false);
                if (shouldRestoreFocus) restoreOpeningFocus();
              }}
            />
          ) : (
            <button
              type="button"
              className="button button--primary add-account-button"
              onClick={(event) => openAddPanel(event.currentTarget)}
              data-testid="accounts-add"
              ref={addAccountButton}
            >
              {t("options_add_account")}
            </button>
          )}
        </section>

        <DisplaySettingsPanel t={t} />

        <DiagnosticsPanel t={t} />

        <section
          className="settings-section about-section"
          aria-labelledby="about-title"
        >
          <div className="section-heading">
            <span className="section-index">04</span>
            <div>
              <h2 id="about-title">{t("options_about_title")}</h2>
              <p>{t("options_about_subtitle")}</p>
            </div>
          </div>
          <p className="about-copy">
            {appConfig ? (
              <>
                {t("options_about_description", {
                  app: appConfig.name,
                  permission: "Pull requests: Read",
                })}{" "}
                <a
                  href="https://github.com/settings/applications"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("options_revoke_link")}
                </a>
                .
              </>
            ) : (
              <>{t("options_metadata_unavailable")}</>
            )}
          </p>
        </section>
      </div>
    </main>
  );
}
