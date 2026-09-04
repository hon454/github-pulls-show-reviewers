import type { Translator } from "../../../src/i18n";
import { useRef, useState } from "react";

import { retryWithAccountRefresh } from "../../../src/auth/account-token-refresh";
import { loadAccountInstallations } from "../../../src/github/installations";
import {
  removeAccount,
  replaceInstallations,
  type Account,
} from "../../../src/storage/accounts";

type Props = {
  t: Translator;
  accounts: Account[];
  onChange: () => Promise<void>;
  onReauthenticate: (account: Account) => void;
};

type AccountAction = "refresh" | "remove";

export function AccountsList({
  accounts,
  onChange,
  onReauthenticate,
  t,
}: Props) {
  const inFlightAccountIds = useRef(new Set<string>());
  const [busyActions, setBusyActions] = useState<
    Record<string, AccountAction | undefined>
  >({});
  const [actionErrors, setActionErrors] = useState<
    Record<string, AccountAction | "token_required" | undefined>
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
    } catch (error) {
      setActionErrors((current) => ({
        ...current,
        [account.id]:
          error instanceof MissingAccountTokenError ? "token_required" : action,
      }));
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
      const installations = await retryWithAccountRefresh({
        account,
        execute: async (token) => {
          if (token == null) {
            throw new MissingAccountTokenError();
          }

          return loadAccountInstallations({ token });
        },
      });
      await replaceInstallations(account.id, installations);
      await onChange();
    });
  }

  async function handleRemove(account: Account) {
    await runAccountAction(account, "remove", async () => {
      await removeAccount(account.id);
      await onChange();
    });
  }

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
    <div className="account-list">
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
            {account.invalidated ? (
              <button
                type="button"
                onClick={() => onReauthenticate(account)}
                className="button button--primary"
              >
                {t("options_signin_again")}
              </button>
            ) : (
              <div className="button-row">
                <button
                  type="button"
                  onClick={() => void handleRefresh(account)}
                  disabled={isBusy}
                  className="button button--secondary"
                >
                  {busyAction === "refresh"
                    ? t("options_refreshing")
                    : t("options_refresh")}
                </button>
                <button
                  type="button"
                  onClick={() => void handleRemove(account)}
                  disabled={isBusy}
                  className="button button--danger"
                >
                  {busyAction === "remove"
                    ? t("options_removing")
                    : t("options_remove")}
                </button>
              </div>
            )}
            {actionError ? (
              <p
                className="inline-status inline-status--error"
                role="status"
                aria-live="polite"
                data-testid={`account-action-error-${account.id}`}
              >
                {t(
                  actionError === "token_required"
                    ? "options_token_required"
                    : actionError === "refresh"
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

class MissingAccountTokenError extends Error {}
