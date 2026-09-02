import { useRef, useState } from "react";

import { retryWithAccountRefresh } from "../../../src/auth/account-token-refresh";
import { loadAccountInstallations } from "../../../src/github/installations";
import {
  removeAccount,
  replaceInstallations,
  type Account,
} from "../../../src/storage/accounts";

type Props = {
  accounts: Account[];
  onChange: () => Promise<void>;
  onReauthenticate: (account: Account) => void;
};

type AccountAction = "refresh" | "remove";

export function AccountsList({ accounts, onChange, onReauthenticate }: Props) {
  const inFlightAccountIds = useRef(new Set<string>());
  const [busyActions, setBusyActions] = useState<
    Record<string, AccountAction | undefined>
  >({});
  const [actionErrors, setActionErrors] = useState<
    Record<string, string | undefined>
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
        [account.id]: `${actionFailureLabel(action)} ${errorMessage(error)}`,
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
            throw new Error(
              "Account token is required to refresh installations.",
            );
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
          <strong>No accounts connected</strong>
          <p>Public repositories will still show reviewer information.</p>
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
                  Installed on:{" "}
                  {account.installations.length === 0
                    ? "none yet"
                    : account.installations
                        .map((installation) => `@${installation.account.login}`)
                        .join(", ")}
                </p>
              </div>
            </div>
            {account.invalidated ? (
              <button
                type="button"
                onClick={() => onReauthenticate(account)}
                className="button button--primary"
              >
                Sign in again
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
                    ? "Refreshing..."
                    : "Refresh installations"}
                </button>
                <button
                  type="button"
                  onClick={() => void handleRemove(account)}
                  disabled={isBusy}
                  className="button button--danger"
                >
                  {busyAction === "remove" ? "Removing..." : "Remove"}
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
                {actionError}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function actionFailureLabel(action: AccountAction): string {
  if (action === "refresh") {
    return "Could not refresh installations.";
  }
  return "Could not remove account.";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Please try again.";
}
