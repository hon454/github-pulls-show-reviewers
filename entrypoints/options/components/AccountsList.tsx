import { type CSSProperties } from "react";

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

export function AccountsList({ accounts, onChange, onReauthenticate }: Props) {
  async function handleRefresh(account: Account) {
    const apiInstallations = await fetchUserInstallations({
      token: account.token,
    });
    const installations: Installation[] = await Promise.all(
      apiInstallations.map(async (installation) => ({
        id: installation.id,
        account: installation.account,
        repositorySelection: installation.repositorySelection,
        repoFullNames:
          installation.repositorySelection === "selected"
            ? await fetchInstallationRepositories({
                token: account.token,
                installationId: installation.id,
              })
            : null,
      })),
    );
    await replaceInstallations(account.id, installations);
    await onChange();
  }

  async function handleRemove(account: Account) {
    await removeAccount(account.id);
    await onChange();
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
      {accounts.map((account) => (
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
                style={styles.secondaryButton}
              >
                Refresh installations
              </button>
              <button
                type="button"
                onClick={() => void handleRemove(account)}
                style={styles.dangerButton}
              >
                Remove
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
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
};
