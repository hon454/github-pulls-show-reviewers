import { useRef, useState, type CSSProperties } from "react";

import { retryWithAccountRefresh } from "../../../src/auth/account-token-refresh";
import {
  fetchInstallationRepositories,
  fetchUserInstallations,
} from "../../../src/github/auth";
import {
  removeAccount,
  replaceInstallations,
  type Account,
  type Installation,
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
            throw new Error("Account token is required to refresh installations.");
          }

          const apiInstallations = await fetchUserInstallations({ token });
          return Promise.all(
            apiInstallations.map(async (installation): Promise<Installation> => ({
              id: installation.id,
              account: installation.account,
              repositorySelection: installation.repositorySelection,
              repoFullNames:
                installation.repositorySelection === "selected"
                  ? await fetchInstallationRepositories({
                      token,
                      installationId: installation.id,
                    })
                  : null,
            })),
          );
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
      <p style={styles.hint} data-testid="accounts-empty">
        No GitHub accounts connected yet.
      </p>
    );
  }

  return (
    <div style={styles.list}>
      {accounts.map((account) => {
        const busyAction = busyActions[account.id];
        const isBusy = busyAction != null;
        const actionError = actionErrors[account.id];

        return (
          <div
            key={account.id}
            style={{
              ...styles.card,
              opacity: account.invalidated ? 0.6 : 1,
            }}
            data-testid={`account-card-${account.login}`}
          >
            <p style={styles.login}>@{account.login}</p>
            <p style={styles.meta}>
              Installed on:{" "}
              {account.installations.length === 0
                ? "none yet"
                : account.installations
                    .map((installation) => `@${installation.account.login}`)
                    .join(", ")}
            </p>
            {account.invalidated ? (
              <button
                type="button"
                onClick={() => onReauthenticate(account)}
                style={styles.primaryButton}
              >
                Sign in again
              </button>
            ) : (
              <div style={styles.actions}>
                <button
                  type="button"
                  onClick={() => void handleRefresh(account)}
                  disabled={isBusy}
                  style={{
                    ...styles.secondaryButton,
                    ...(isBusy ? styles.disabledButton : null),
                  }}
                >
                  {busyAction === "refresh"
                    ? "Refreshing..."
                    : "Refresh installations"}
                </button>
                <button
                  type="button"
                  onClick={() => void handleRemove(account)}
                  disabled={isBusy}
                  style={{
                    ...styles.dangerButton,
                    ...(isBusy ? styles.disabledButton : null),
                  }}
                >
                  {busyAction === "remove" ? "Removing..." : "Remove"}
                </button>
              </div>
            )}
            {actionError ? (
              <p
                style={styles.error}
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

const styles: Record<string, CSSProperties> = {
  list: { display: "grid", gap: 12 },
  card: {
    padding: 16,
    borderRadius: 16,
    background: "#fffdf9",
    border: "1px solid rgba(34, 29, 24, 0.08)",
  },
  login: { margin: 0, fontWeight: 700 },
  meta: { margin: "6px 0 0", fontSize: 13, color: "#52463b" },
  actions: { display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" },
  hint: { color: "#6e5f52", fontSize: 13 },
  primaryButton: {
    border: 0,
    borderRadius: 999,
    padding: "10px 16px",
    background: "#1f6feb",
    color: "white",
    fontWeight: 700,
    cursor: "pointer",
    marginTop: 12,
  },
  secondaryButton: {
    borderRadius: 999,
    padding: "10px 16px",
    background: "#fffdf9",
    border: "1px solid #d3c4ae",
    color: "#3b3024",
    fontWeight: 700,
    cursor: "pointer",
  },
  dangerButton: {
    borderRadius: 999,
    padding: "10px 16px",
    background: "#fff4f4",
    border: "1px solid rgba(207, 34, 46, 0.18)",
    color: "#cf222e",
    fontWeight: 700,
    cursor: "pointer",
  },
  disabledButton: {
    opacity: 0.65,
    cursor: "not-allowed",
  },
  error: {
    margin: "10px 0 0",
    color: "#cf222e",
    fontSize: 13,
    lineHeight: 1.5,
  },
};
