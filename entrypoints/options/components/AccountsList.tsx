import type { Translator } from "../../../src/i18n";
import { useEffect, useRef, useState } from "react";

import { removeAccount } from "../../../src/runtime/account-mutations";
import { refreshAccountInstallations } from "../../../src/runtime/installation-refresh";
import type { AccountSummary as Account } from "../../../src/runtime/ui-contract";

type Props = {
  t: Translator;
  accounts: Account[];
  onChange: () => Promise<void>;
  onReauthenticate: (account: Account, control: HTMLButtonElement) => void;
  /** Focus target once the last account row is removed. */
  onListEmptiedFocus?: () => void;
};

type AccountAction = "refresh" | "remove";

export function AccountsList({
  accounts,
  onChange,
  onReauthenticate,
  onListEmptiedFocus,
  t,
}: Props) {
  const list = useRef<HTMLDivElement | null>(null);
  // Row index whose removal took focus with it; focus moves to the row now in
  // that position (or the previous one, or the add button) once it renders.
  const removedFocusIndex = useRef<number | null>(null);
  const inFlightAccountIds = useRef(new Set<string>());
  const [busyActions, setBusyActions] = useState<
    Record<string, AccountAction | undefined>
  >({});
  const [actionErrors, setActionErrors] = useState<
    Record<string, AccountAction | undefined>
  >({});

  async function runAccountAction(
    account: Account,
    action: AccountAction,
    execute: () => Promise<void>,
  ) {
    if (inFlightAccountIds.current.has(account.id)) {
      return;
    }

    inFlightAccountIds.current.add(account.id);
    setBusyActions((current) => ({ ...current, [account.id]: action }));
    setActionErrors((current) => ({ ...current, [account.id]: undefined }));

    try {
      await execute();
    } catch {
      setActionErrors((current) => ({ ...current, [account.id]: action }));
    } finally {
      inFlightAccountIds.current.delete(account.id);
      setBusyActions((current) => {
        const next = { ...current };
        delete next[account.id];
        return next;
      });
    }
  }

  async function handleRefresh(account: Account) {
    await runAccountAction(account, "refresh", async () => {
      const outcome = await refreshAccountInstallations(account.id);
      if (!outcome?.ok) throw new Error("installation_refresh_failed");
      await onChange();
    });
  }

  async function handleRemove(account: Account) {
    const index = accounts.findIndex((entry) => entry.id === account.id);
    await runAccountAction(account, "remove", async () => {
      await removeAccount(account.id);
      removedFocusIndex.current = index;
      await onChange();
    });
  }

  useEffect(() => {
    const index = removedFocusIndex.current;
    if (index === null) return;
    if (accounts.length > 0 && !list.current) return;
    const focusLost =
      document.activeElement === document.body ||
      !document.activeElement?.isConnected;
    if (!focusLost) {
      removedFocusIndex.current = null;
      return;
    }
    const rows = list.current?.querySelectorAll(".account-row") ?? [];
    const row = rows[Math.min(index, rows.length - 1)];
    const next = row?.querySelector<HTMLButtonElement>("button");
    if (next) {
      removedFocusIndex.current = null;
      next.focus();
    } else if (accounts.length === 0) {
      removedFocusIndex.current = null;
      onListEmptiedFocus?.();
    }
  }, [accounts, onListEmptiedFocus]);

  if (accounts.length === 0) {
    return (
      <div className="empty-state" data-testid="accounts-empty">
        <span className="empty-state-mark" aria-hidden="true">
          @
        </span>
        <div>
          <strong>{t("options_accounts_empty")}</strong>
          <p>{t("options_accounts_empty_description")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="account-list" ref={list}>
      {accounts.map((account) => {
        const busyAction = busyActions[account.id];
        const isBusy = busyAction != null;
        const actionError = actionErrors[account.id];

        return (
          <div
            key={account.id}
            className={`account-row${account.invalidated ? " account-row--invalid" : ""}`}
            data-testid={`account-card-${account.login}`}
          >
            <div className="account-identity">
              <span className="account-avatar" aria-hidden="true">
                {account.login.slice(0, 1).toUpperCase()}
              </span>
              <div>
                <p className="account-login">@{account.login}</p>
                <p className="account-meta">
                  {account.installations.length === 0
                    ? t("options_installed_none")
                    : t("options_installed_on", {
                        accounts: account.installations
                          .map(
                            (installation) => `@${installation.account.login}`,
                          )
                          .join(", "),
                      })}
                </p>
              </div>
            </div>
            <div className="button-row">
              {account.invalidated ? (
                <button
                  type="button"
                  onClick={(event) => {
                    if (!isBusy) onReauthenticate(account, event.currentTarget);
                  }}
                  aria-disabled={isBusy || undefined}
                  className="button button--primary"
                >
                  {t("options_signin_again")}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleRefresh(account)}
                  aria-disabled={isBusy || undefined}
                  aria-busy={busyAction === "refresh" || undefined}
                  className="button button--secondary"
                >
                  {busyAction === "refresh"
                    ? t("options_refreshing")
                    : t("options_refresh")}
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleRemove(account)}
                aria-disabled={isBusy || undefined}
                aria-busy={busyAction === "remove" || undefined}
                className="button button--danger"
              >
                {busyAction === "remove"
                  ? t("options_removing")
                  : t("options_remove")}
              </button>
            </div>
            {actionError ? (
              <p
                className="inline-status inline-status--error"
                role="status"
                aria-live="polite"
                data-testid={`account-action-error-${account.id}`}
              >
                {t(
                  actionError === "refresh"
                    ? "options_refresh_failed"
                    : "options_remove_failed",
                )}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
