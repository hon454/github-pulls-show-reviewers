import { StrictMode, useEffect, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";

import { validateGitHubToken } from "../../src/github/api";
import { getStoredSettings, saveStoredSettings } from "../../src/storage/settings";

type StatusState = {
  tone: "neutral" | "success" | "error";
  message: string;
};

function OptionsPage() {
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<StatusState>({
    tone: "neutral",
    message: "Token is optional for public repositories.",
  });
  const [isSaving, setIsSaving] = useState(false);
  const [isValidating, setIsValidating] = useState(false);

  useEffect(() => {
    void getStoredSettings().then((settings) => {
      setToken(settings.githubToken ?? "");
    });
  }, []);

  async function handleSave() {
    setIsSaving(true);
    try {
      await saveStoredSettings({ githubToken: token.trim() || null });
      setStatus({
        tone: "success",
        message: token.trim()
          ? "Settings saved. Review pages can now use this token."
          : "Token cleared. Public repositories should continue to work without it.",
      });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleValidate() {
    const trimmedToken = token.trim();
    if (!trimmedToken) {
      setStatus({
        tone: "error",
        message: "Enter a token to validate before running a GitHub check.",
      });
      return;
    }

    setIsValidating(true);
    setStatus({
      tone: "neutral",
      message: "Checking the token against the GitHub API...",
    });

    try {
      const result = await validateGitHubToken(trimmedToken);
      if (result.ok) {
        setStatus({
          tone: "success",
          message: `GitHub accepted the token. Core API remaining: ${result.remaining}/${result.limit}.`,
        });
        return;
      }

      setStatus({
        tone: "error",
        message: result.message,
      });
    } finally {
      setIsValidating(false);
    }
  }

  return (
    <main style={styles.page}>
      <section style={styles.card}>
        <p style={styles.eyebrow}>GitHub Pulls Show Reviewers</p>
        <h1 style={styles.title}>Reviewer visibility for GitHub pull request lists</h1>
        <p style={styles.body}>
          Save a fine-grained personal access token if you need private repository access.
          Public repositories should remain a no-token path when implementation is complete.
        </p>
        <label htmlFor="github-token" style={styles.label}>
          GitHub token
        </label>
        <input
          id="github-token"
          type="password"
          value={token}
          onChange={(event) => setToken(event.currentTarget.value)}
          placeholder="github_pat_..."
          style={styles.input}
        />
        <p style={styles.hint}>
          Prefer a fine-grained token with the minimum read permissions needed for pull
          request data.
        </p>
        <div style={styles.actions}>
          <button
            onClick={() => void handleSave()}
            style={styles.primaryButton}
            disabled={isSaving || isValidating}
          >
            {isSaving ? "Saving..." : "Save settings"}
          </button>
          <button
            onClick={() => void handleValidate()}
            style={styles.secondaryButton}
            disabled={isSaving || isValidating}
          >
            {isValidating ? "Checking..." : "Validate token"}
          </button>
        </div>
        <p style={statusStyles[status.tone]}>{status.message}</p>
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
  label: {
    display: "block",
    marginTop: 28,
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
  },
  actions: {
    display: "flex",
    gap: 12,
    marginTop: 20,
    flexWrap: "wrap",
  },
  primaryButton: {
    marginTop: 20,
    border: 0,
    borderRadius: 999,
    padding: "12px 18px",
    background: "#1f6feb",
    color: "white",
    fontWeight: 700,
    cursor: "pointer",
  },
  secondaryButton: {
    marginTop: 20,
    borderRadius: 999,
    padding: "12px 18px",
    background: "#fffdf9",
    border: "1px solid #d3c4ae",
    color: "#3b3024",
    fontWeight: 700,
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <OptionsPage />
  </StrictMode>,
);
