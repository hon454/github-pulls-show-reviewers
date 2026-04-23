import { useState, type CSSProperties } from "react";

import { validateRepositoryAccessWithAccount } from "../../../src/auth/account-token-refresh";
import { validateGitHubRepositoryAccess } from "../../../src/github/api";
import {
  resolveAccountForRepo,
  type Account,
} from "../../../src/storage/accounts";

type Status =
  | { tone: "neutral" | "success" | "error"; message: string }
  | null;

export function DiagnosticsPanel() {
  const [repository, setRepository] = useState("");
  const [status, setStatus] = useState<Status>(null);
  const [matchedAccount, setMatchedAccount] = useState<Account | null>(null);
  const [busy, setBusy] = useState(false);

  async function runMatched() {
    const trimmed = repository.trim();
    const match = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
    if (!match) {
      setStatus({
        tone: "error",
        message: "Enter a repository as owner/name before running diagnostics.",
      });
      return;
    }
    setBusy(true);
    try {
      const account = await resolveAccountForRepo(match[1], match[2]);
      setMatchedAccount(account);
      if (account == null) {
        setStatus({
          tone: "error",
          message: `No connected account covers ${trimmed}. Install the GitHub App on the owner.`,
        });
        return;
      }
      const result = await validateRepositoryAccessWithAccount({
        account,
        repository: trimmed,
      });
      setStatus({ tone: result.ok ? "success" : "error", message: result.message });
    } finally {
      setBusy(false);
    }
  }

  async function runNoToken() {
    const trimmed = repository.trim();
    if (!trimmed) {
      setStatus({
        tone: "error",
        message: "Enter a repository before running the no-token check.",
      });
      return;
    }
    setBusy(true);
    setMatchedAccount(null);
    try {
      const result = await validateGitHubRepositoryAccess(null, trimmed);
      setStatus({ tone: result.ok ? "success" : "error", message: result.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={styles.section}>
      <h2 style={styles.heading}>Diagnostics</h2>
      <input
        type="text"
        value={repository}
        placeholder="owner/name"
        onChange={(event) => setRepository(event.currentTarget.value)}
        style={styles.input}
        data-testid="diagnostics-repo"
      />
      <div style={styles.actions}>
        <button
          type="button"
          onClick={() => void runMatched()}
          disabled={busy}
          style={styles.primaryButton}
          data-testid="diagnostics-matched"
        >
          Check matched account
        </button>
        <button
          type="button"
          onClick={() => void runNoToken()}
          disabled={busy}
          style={styles.secondaryButton}
          data-testid="diagnostics-no-token"
        >
          Check no-token path
        </button>
      </div>
      {matchedAccount ? (
        <p style={styles.hint}>Matched account: @{matchedAccount.login}.</p>
      ) : null}
      {status ? (
        <p style={{ ...styles.hint, color: toneColor(status.tone) }}>
          {status.message}
        </p>
      ) : null}
    </section>
  );
}

function toneColor(tone: "neutral" | "success" | "error"): string {
  if (tone === "success") return "#1a7f37";
  if (tone === "error") return "#cf222e";
  return "#52463b";
}

const styles: Record<string, CSSProperties> = {
  section: { marginTop: 32 },
  heading: { margin: 0, fontSize: 18 },
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "14px 16px",
    borderRadius: 12,
    border: "1px solid #d3c4ae",
    background: "#fffdf9",
    fontSize: 15,
    marginTop: 12,
  },
  actions: { display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" },
  hint: { fontSize: 13, color: "#52463b", marginTop: 12 },
  primaryButton: {
    border: 0,
    borderRadius: 999,
    padding: "10px 16px",
    background: "#1f6feb",
    color: "white",
    fontWeight: 700,
    cursor: "pointer",
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
};
