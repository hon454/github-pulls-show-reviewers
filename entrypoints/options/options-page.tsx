import { useEffect, useState, type CSSProperties } from "react";

import {
  type RepositoryValidationResult,
  validateGitHubRepositoryAccess,
  validateGitHubToken,
} from "../../src/github/api";
import {
  getStoredSettings,
  saveStoredSettings,
} from "../../src/storage/settings";

type StatusState = {
  tone: "neutral" | "success" | "error";
  message: string;
};

const FINE_GRAINED_PAT_URL = "https://github.com/settings/personal-access-tokens/new";

export function buildFineGrainedPatUrl(repository: string): string {
  const url = new URL(FINE_GRAINED_PAT_URL);

  url.searchParams.set("name", "GitHub Pulls Show Reviewers");
  url.searchParams.set(
    "description",
    "Read reviewer metadata for GitHub pull request lists",
  );
  url.searchParams.set("pull_requests", "read");

  const owner = extractRepositoryOwner(repository);
  if (owner) {
    url.searchParams.set("target_name", owner);
  }

  return url.toString();
}

function extractRepositoryOwner(repository: string): string | null {
  const trimmed = repository.trim().replace(/^\/+|\/+$/g, "");
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(trimmed);
  return match ? match[1] : null;
}

export function OptionsPage() {
  const [token, setToken] = useState("");
  const [repository, setRepository] = useState("");
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
      const trimmedRepository = repository.trim();
      if (trimmedRepository) {
        const repositoryResult = await validateGitHubRepositoryAccess(
          trimmedToken,
          trimmedRepository,
        );
        setStatus({
          tone: getRepositoryValidationTone(repositoryResult),
          message: repositoryResult.message,
        });
        return;
      }

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
          repositories, save a fine-grained personal access token scoped only to
          the owners and repositories this extension reads.
        </p>
        <div style={styles.guidanceBox}>
          <p style={styles.guidanceTitle}>
            Recommended fine-grained token setup
          </p>
          <ul style={styles.guidanceList}>
            <li>Repository access: Only select repositories</li>
            <li>Repository permissions: Pull requests - Read-only</li>
            <li>No write permissions are required for this extension</li>
          </ul>
          <p style={styles.guidanceNote}>
            Organization-owned repositories may also require org approval before
            the token can read pull requests.
          </p>
        </div>
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
          Use a fine-grained PAT such as <code>github_pat_...</code>. The
          reviewer UI only reads pull request metadata and review history.
        </p>
        <div style={styles.inlineActions}>
          <a
            href={buildFineGrainedPatUrl(repository)}
            target="_blank"
            rel="noreferrer"
            style={styles.linkButton}
          >
            Create fine-grained PAT
          </a>
        </div>
        <p style={styles.hint}>
          Opens GitHub&apos;s token creation page with{" "}
          <code>Pull requests: Read</code> preselected. If you enter a
          repository below, the link also targets that owner.
        </p>
        <label htmlFor="repository-check" style={styles.label}>
          Repository access check
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
          check. Both checks first discover one pull request in this repository,
          then verify the exact <code>GET /pulls/{`{n}`}</code> and{" "}
          <code>/reviews</code>
          endpoints used by the content script. Use the no-token check to
          confirm whether a public repository can stay on the anonymous path.
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
          <button
            onClick={() => void handleNoTokenRepositoryCheck()}
            style={styles.secondaryButton}
            disabled={isSaving || isValidating}
          >
            {isValidating ? "Checking..." : "Check no-token repository"}
          </button>
        </div>
        <p style={statusStyles[status.tone]}>{status.message}</p>
      </section>
    </main>
  );
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
    lineHeight: 1.6,
  },
  inlineActions: {
    display: "flex",
    gap: 12,
    marginTop: 16,
    flexWrap: "wrap",
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
