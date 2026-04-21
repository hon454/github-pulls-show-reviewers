import { useEffect, useState, type CSSProperties } from "react";

import {
  type RepositoryValidationResult,
  validateGitHubRepositoryAccess,
  validateGitHubToken,
} from "../../src/github/api";
import {
  findDuplicateTokenScope,
  maskToken,
  parseTokenScope,
  resolveTokenEntryForRepository,
  validateTokenScopeParts,
} from "../../src/storage/token-scopes";
import {
  getStoredSettings,
  saveStoredSettings,
  type TokenEntry,
} from "../../src/storage/settings";

type StatusState = {
  tone: "neutral" | "success" | "error";
  message: string;
};

type ScopeType = "owner" | "repo";

const CLASSIC_PAT_NEW_URL = "https://github.com/settings/tokens/new";
const CLASSIC_PAT_MANAGEMENT_URL = "https://github.com/settings/tokens";

export function buildClassicPatUrl(): string {
  const url = new URL(CLASSIC_PAT_NEW_URL);

  url.searchParams.set("scopes", "repo");
  url.searchParams.set(
    "description",
    "GitHub Pulls Show Reviewers — read reviewer metadata",
  );

  return url.toString();
}

export function OptionsPage() {
  const [tokenEntries, setTokenEntries] = useState<TokenEntry[]>([]);
  const [tokenOwner, setTokenOwner] = useState("");
  const [scopeType, setScopeType] = useState<ScopeType>("owner");
  const [tokenRepo, setTokenRepo] = useState("");
  const [tokenLabel, setTokenLabel] = useState("");
  const [tokenValue, setTokenValue] = useState("");
  const [repository, setRepository] = useState("");
  const [matchedScopeMessage, setMatchedScopeMessage] = useState<string | null>(
    null,
  );
  const [status, setStatus] = useState<StatusState>({
    tone: "neutral",
    message: "Token is optional for public repositories.",
  });
  const [isSaving, setIsSaving] = useState(false);
  const [isValidating, setIsValidating] = useState(false);

  useEffect(() => {
    void getStoredSettings().then((settings) => {
      setTokenEntries(settings.tokenEntries);
    });
  }, []);

  async function persistTokenEntries(nextEntries: TokenEntry[]) {
    await saveStoredSettings({ tokenEntries: nextEntries });
    setTokenEntries(nextEntries);
  }

  async function handleValidateAndSave() {
    const repoValue = scopeType === "repo" ? tokenRepo : null;
    const scopeResult = validateTokenScopeParts(tokenOwner, repoValue);
    if (scopeResult.ok === false) {
      setStatus({
        tone: "error",
        message: scopeResult.message,
      });
      return;
    }

    const trimmedToken = tokenValue.trim();
    if (!trimmedToken) {
      setStatus({
        tone: "error",
        message: "Enter a token before validating and saving it.",
      });
      return;
    }

    const duplicate = findDuplicateTokenScope(tokenEntries, scopeResult.scope);
    if (duplicate) {
      setStatus({
        tone: "error",
        message: `A token for ${scopeResult.scope} is already saved.`,
      });
      return;
    }

    setIsSaving(true);
    setMatchedScopeMessage(null);
    setStatus({
      tone: "neutral",
      message: "Checking the token against the GitHub API...",
    });

    try {
      const result = await validateGitHubToken(trimmedToken);
      if (result.ok === false) {
        setStatus({
          tone: "error",
          message: result.message,
        });
        return;
      }

      const nextEntries = [
        ...tokenEntries,
        {
          id: createTokenEntryId(),
          scope: scopeResult.scope,
          token: trimmedToken,
          label: tokenLabel.trim() || null,
        },
      ];
      await persistTokenEntries(nextEntries);
      setTokenOwner("");
      setScopeType("owner");
      setTokenRepo("");
      setTokenLabel("");
      setTokenValue("");
      setStatus({
        tone: "success",
        message: `Saved token for ${scopeResult.scope}. Core API remaining: ${result.remaining}/${result.limit}.`,
      });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDeleteToken(id: string) {
    setIsSaving(true);
    setMatchedScopeMessage(null);

    try {
      const nextEntries = tokenEntries.filter((entry) => entry.id !== id);
      await persistTokenEntries(nextEntries);
      setStatus({
        tone: "success",
        message: "Saved token scope deleted.",
      });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleMatchedTokenCheck() {
    const trimmedRepository = repository.trim();
    if (!trimmedRepository) {
      setStatus({
        tone: "error",
        message:
          "Enter a repository in owner/name form before running a matched-token check.",
      });
      return;
    }

    const tokenEntry = resolveTokenEntryForRepository(
      { tokenEntries },
      trimmedRepository,
    );
    if (tokenEntry == null) {
      setMatchedScopeMessage(null);
      setStatus({
        tone: "error",
        message: `No saved token matches ${trimmedRepository}.`,
      });
      return;
    }

    setIsValidating(true);
    setMatchedScopeMessage(`Matched token scope: ${tokenEntry.scope}.`);
    setStatus({
      tone: "neutral",
      message: "Checking the matched token against the GitHub API...",
    });

    try {
      const repositoryResult = await validateGitHubRepositoryAccess(
        tokenEntry.token,
        trimmedRepository,
      );
      setStatus({
        tone: getRepositoryValidationTone(repositoryResult),
        message: repositoryResult.message,
      });
    } finally {
      setIsValidating(false);
    }
  }

  async function handleNoTokenRepositoryCheck() {
    const trimmedRepository = repository.trim();
    if (!trimmedRepository) {
      setStatus({
        tone: "error",
        message:
          "Enter a repository in owner/name form before running a no-token check.",
      });
      return;
    }

    setIsValidating(true);
    setMatchedScopeMessage(null);
    setStatus({
      tone: "neutral",
      message:
        "Checking whether this repository works on the public no-token path...",
    });

    try {
      const repositoryResult = await validateGitHubRepositoryAccess(
        null,
        trimmedRepository,
      );
      setStatus({
        tone: getRepositoryValidationTone(repositoryResult),
        message: repositoryResult.message,
      });
    } finally {
      setIsValidating(false);
    }
  }

  return (
    <main style={styles.page}>
      <section style={styles.card}>
        <p style={styles.eyebrow}>GitHub Pulls Show Reviewers</p>
        <h1 style={styles.title}>
          Reviewer visibility for GitHub pull request lists
        </h1>
        <p style={styles.body}>
          Public repositories can stay on the no-token path. For private
          repositories, save a GitHub classic personal access token scoped to
          the minimum needed for reading pull request reviewer metadata.
        </p>
        <div style={styles.guidanceBox}>
          <p style={styles.guidanceTitle}>Recommended classic PAT setup</p>
          <ul style={styles.guidanceList}>
            <li>
              Public-only access: the <code>public_repo</code> scope is enough
            </li>
            <li>
              Private repositories: the <code>repo</code> scope (note the
              broader surface area — the extension only performs read operations)
            </li>
            <li>No write permissions are required for this extension</li>
          </ul>
          <p style={styles.guidanceNote}>
            After creating the token, open the{" "}
            <a
              href={CLASSIC_PAT_MANAGEMENT_URL}
              target="_blank"
              rel="noreferrer"
            >
              token settings page
            </a>{" "}
            and click <strong>Configure SSO → Authorize</strong> for each
            organization with private repositories.
          </p>
        </div>

        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>Saved token scopes</h2>
          {tokenEntries.length === 0 ? (
            <p style={styles.hint}>No saved token scopes yet.</p>
          ) : (
            <div style={styles.tokenList}>
              {tokenEntries.map((entry) => {
                const parsedScope = parseTokenScope(entry.scope);
                if (parsedScope == null) {
                  return null;
                }

                return (
                  <div key={entry.id} style={styles.tokenCard}>
                    <div style={styles.tokenCardHeader}>
                      <div>
                        <p style={styles.tokenOwner}>{parsedScope.owner}</p>
                        <p style={styles.tokenScopeType}>
                          {parsedScope.scopeType === "owner"
                            ? "All repos under this owner"
                            : "Single repository"}
                        </p>
                      </div>
                      <button
                        type="button"
                        style={styles.deleteButton}
                        disabled={isSaving || isValidating}
                        onClick={() => void handleDeleteToken(entry.id)}
                      >
                        Delete
                      </button>
                    </div>
                    {parsedScope.repo ? (
                      <p style={styles.tokenMeta}>Repository: {parsedScope.repo}</p>
                    ) : null}
                    {entry.label ? (
                      <p style={styles.tokenMeta}>Label: {entry.label}</p>
                    ) : null}
                    <p style={styles.tokenMeta}>Token: {maskToken(entry.token)}</p>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>Add token</h2>
          <label htmlFor="token-owner" style={styles.label}>
            Owner
          </label>
          <input
            id="token-owner"
            type="text"
            value={tokenOwner}
            onChange={(event) => setTokenOwner(event.currentTarget.value)}
            placeholder="owner"
            style={styles.input}
          />

          <label htmlFor="scope-type" style={styles.label}>
            Scope type
          </label>
          <select
            id="scope-type"
            value={scopeType}
            onChange={(event) =>
              setScopeType(event.currentTarget.value as ScopeType)
            }
            style={styles.input}
          >
            <option value="owner">All repos under this owner</option>
            <option value="repo">Single repository</option>
          </select>

          {scopeType === "repo" ? (
            <>
              <label htmlFor="token-repo" style={styles.label}>
                Repository
              </label>
              <input
                id="token-repo"
                type="text"
                value={tokenRepo}
                onChange={(event) => setTokenRepo(event.currentTarget.value)}
                placeholder="repo-name"
                style={styles.input}
              />
            </>
          ) : null}

          <label htmlFor="token-label" style={styles.label}>
            Label
          </label>
          <input
            id="token-label"
            type="text"
            value={tokenLabel}
            onChange={(event) => setTokenLabel(event.currentTarget.value)}
            placeholder="Optional"
            style={styles.input}
          />

          <label htmlFor="token-value" style={styles.label}>
            GitHub token
          </label>
          <input
            id="token-value"
            type="password"
            value={tokenValue}
            onChange={(event) => setTokenValue(event.currentTarget.value)}
            placeholder="ghp_..."
            style={styles.input}
          />
          <p style={styles.hint}>
            Use a GitHub classic PAT (token strings start with{" "}
            <code>ghp_</code>). The reviewer UI only reads pull request metadata
            and review history.
          </p>
          <div style={styles.inlineActions}>
            <a
              href={buildClassicPatUrl()}
              target="_blank"
              rel="noreferrer"
              style={styles.linkButton}
            >
              Create classic PAT
            </a>
            <button
              type="button"
              data-testid="validate-save-token"
              onClick={() => void handleValidateAndSave()}
              style={styles.primaryButton}
              disabled={isSaving || isValidating}
            >
              {isSaving ? "Saving..." : "Validate and save"}
            </button>
          </div>
          <p style={styles.hint}>
            The PAT link keeps the repository-check owner in sync. Token save
            validates only that GitHub accepts the token; repository access is
            checked separately below.
          </p>
        </section>

        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>Repository access check</h2>
          <label htmlFor="repository-check" style={styles.label}>
            Repository
          </label>
          <input
            id="repository-check"
            type="text"
            value={repository}
            onChange={(event) => setRepository(event.currentTarget.value)}
            placeholder="owner/name"
            style={styles.input}
          />
          <p style={styles.hint}>
            Optional. Leave this blank until you want to run a repo-specific
            check. Matched-token checks use the exact scope resolution that the
            content script uses at runtime.
          </p>
          {matchedScopeMessage ? (
            <p style={styles.scopeMessage}>{matchedScopeMessage}</p>
          ) : null}
          <div style={styles.actions}>
            <button
              type="button"
              data-testid="check-matched-token"
              onClick={() => void handleMatchedTokenCheck()}
              style={styles.primaryButton}
              disabled={isSaving || isValidating}
            >
              {isValidating ? "Checking..." : "Check matched token"}
            </button>
            <button
              type="button"
              onClick={() => void handleNoTokenRepositoryCheck()}
              style={styles.secondaryButton}
              disabled={isSaving || isValidating}
            >
              {isValidating ? "Checking..." : "Check no-token repository"}
            </button>
          </div>
        </section>

        <p style={statusStyles[status.tone]}>{status.message}</p>
      </section>
    </main>
  );
}

function createTokenEntryId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `token-${Date.now()}`;
}

function getRepositoryValidationTone(
  result: RepositoryValidationResult,
): StatusState["tone"] {
  if (result.ok) {
    return "success";
  }

  if (result.outcome === "no-pulls") {
    return "neutral";
  }

  return "error";
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
  sectionTitle: {
    margin: 0,
    fontSize: 20,
  },
  eyebrow: {
    margin: 0,
    textTransform: "uppercase",
    letterSpacing: "0.12em",
    fontSize: 12,
    color: "#9f5a14",
    fontWeight: 700,
  },
  title: {
    margin: "12px 0 16px",
    fontSize: 36,
    lineHeight: 1.1,
  },
  body: {
    margin: 0,
    maxWidth: 560,
    color: "#52463b",
    lineHeight: 1.6,
  },
  guidanceBox: {
    marginTop: 20,
    padding: 16,
    borderRadius: 16,
    background: "rgba(255, 251, 245, 0.92)",
    border: "1px solid rgba(159, 90, 20, 0.16)",
  },
  guidanceTitle: {
    margin: 0,
    fontSize: 14,
    fontWeight: 700,
    color: "#6f3f11",
  },
  guidanceList: {
    margin: "10px 0 0 18px",
    padding: 0,
    color: "#52463b",
    lineHeight: 1.7,
    fontSize: 14,
  },
  guidanceNote: {
    margin: "12px 0 0",
    color: "#6e5f52",
    fontSize: 13,
    lineHeight: 1.6,
  },
  label: {
    display: "block",
    marginTop: 20,
    marginBottom: 10,
    fontSize: 14,
    fontWeight: 700,
  },
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "14px 16px",
    borderRadius: 12,
    border: "1px solid #d3c4ae",
    background: "#fffdf9",
    fontSize: 15,
  },
  hint: {
    marginTop: 10,
    color: "#6e5f52",
    fontSize: 13,
    lineHeight: 1.6,
  },
  tokenList: {
    display: "grid",
    gap: 12,
    marginTop: 16,
  },
  tokenCard: {
    padding: 16,
    borderRadius: 16,
    background: "#fffdf9",
    border: "1px solid rgba(34, 29, 24, 0.08)",
  },
  tokenCardHeader: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "flex-start",
  },
  tokenOwner: {
    margin: 0,
    fontWeight: 700,
    fontSize: 16,
  },
  tokenScopeType: {
    margin: "4px 0 0",
    color: "#6e5f52",
    fontSize: 13,
  },
  tokenMeta: {
    margin: "10px 0 0",
    color: "#52463b",
    fontSize: 14,
  },
  scopeMessage: {
    marginTop: 14,
    color: "#6f3f11",
    fontSize: 14,
  },
  inlineActions: {
    display: "flex",
    gap: 12,
    marginTop: 16,
    flexWrap: "wrap",
    alignItems: "center",
  },
  actions: {
    display: "flex",
    gap: 12,
    marginTop: 20,
    flexWrap: "wrap",
  },
  primaryButton: {
    border: 0,
    borderRadius: 999,
    padding: "12px 18px",
    background: "#1f6feb",
    color: "white",
    fontWeight: 700,
    cursor: "pointer",
  },
  secondaryButton: {
    borderRadius: 999,
    padding: "12px 18px",
    background: "#fffdf9",
    border: "1px solid #d3c4ae",
    color: "#3b3024",
    fontWeight: 700,
    cursor: "pointer",
  },
  deleteButton: {
    borderRadius: 999,
    padding: "8px 14px",
    background: "#fff4f4",
    border: "1px solid rgba(207, 34, 46, 0.18)",
    color: "#cf222e",
    fontWeight: 700,
    cursor: "pointer",
  },
  linkButton: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    borderRadius: 999,
    padding: "12px 18px",
    background: "#fffdf9",
    border: "1px solid #d3c4ae",
    color: "#3b3024",
    fontWeight: 700,
    textDecoration: "none",
    cursor: "pointer",
  },
};

const statusStyles: Record<StatusState["tone"], CSSProperties> = {
  neutral: {
    marginTop: 16,
    color: "#52463b",
    fontSize: 14,
  },
  success: {
    marginTop: 16,
    color: "#1a7f37",
    fontSize: 14,
  },
  error: {
    marginTop: 16,
    color: "#cf222e",
    fontSize: 14,
  },
};
