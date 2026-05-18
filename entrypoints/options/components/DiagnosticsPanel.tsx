import { useRef, useState, type CSSProperties } from "react";

import { validateRepositoryAccessWithAccount } from "../../../src/auth/account-token-refresh";
import {
  buildMatchedAccountDiagnostic,
  buildNoTokenDiagnostic,
  buildUncoveredAccountDiagnostic,
  type RepositoryDiagnosticTone,
  type RepositoryDiagnosticViewModel,
} from "../../../src/features/repository-diagnostics";
import { validateGitHubRepositoryAccess } from "../../../src/github/api";
import { resolveAccountCoverageForRepo } from "../../../src/storage/accounts";

export function DiagnosticsPanel() {
  const [repository, setRepository] = useState("");
  const [diagnostic, setDiagnostic] =
    useState<RepositoryDiagnosticViewModel | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  async function runDiagnostic(execute: () => Promise<void>) {
    if (busyRef.current) {
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setDiagnostic({
      tone: "neutral",
      message: "Running diagnostics...",
      fields: [],
    });
    try {
      await execute();
    } catch (error) {
      setDiagnostic({
        tone: "error",
        message: `Could not run diagnostics. ${errorMessage(error)}`,
        fields: [],
      });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function runMatched() {
    const trimmed = repository.trim();
    const match = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
    if (!match) {
      setDiagnostic({
        tone: "error",
        message: "Enter a repository as owner/name before running diagnostics.",
        fields: [],
      });
      return;
    }
    await runDiagnostic(async () => {
      const resolution = await resolveAccountCoverageForRepo(match[1], match[2]);
      if (resolution.status === "uncovered") {
        setDiagnostic(
          buildUncoveredAccountDiagnostic(
            trimmed,
            `No connected account covers ${trimmed}. Install the GitHub App on the owner.`,
          ),
        );
        return;
      }
      const result = await validateRepositoryAccessWithAccount({
        account: resolution.account,
        repository: trimmed,
      });
      setDiagnostic(
        buildMatchedAccountDiagnostic({
          repository: trimmed,
          coverageStatus: resolution.status,
          account: resolution.account,
          result,
        }),
      );
    });
  }

  async function runNoToken() {
    const trimmed = repository.trim();
    if (!trimmed) {
      setDiagnostic({
        tone: "error",
        message: "Enter a repository before running the no-token check.",
        fields: [],
      });
      return;
    }
    await runDiagnostic(async () => {
      const result = await validateGitHubRepositoryAccess(null, trimmed);
      setDiagnostic(buildNoTokenDiagnostic({ repository: trimmed, result }));
    });
  }

  return (
    <section style={styles.section}>
      <h2 style={styles.heading}>Diagnostics</h2>
      <label htmlFor="diagnostics-repository" style={styles.visuallyHidden}>
        Repository in owner/name format
      </label>
      <input
        id="diagnostics-repository"
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
      {diagnostic ? (
        <>
          <p
            style={{ ...styles.hint, color: toneColor(diagnostic.tone) }}
            role="status"
            aria-live="polite"
            data-testid="diagnostics-status"
          >
            {diagnostic.message}
          </p>
          {diagnostic.fields.length > 0 ? (
            <dl style={styles.diagnosticFields} data-testid="diagnostics-fields">
              {diagnostic.fields.map((field) => (
                <div key={field.label} style={styles.diagnosticField}>
                  <dt style={styles.diagnosticLabel}>{field.label}</dt>
                  <dd
                    style={{
                      ...styles.diagnosticValue,
                      color: toneColor(field.tone),
                    }}
                  >
                    {field.value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Please try again.";
}

function toneColor(tone: RepositoryDiagnosticTone): string {
  if (tone === "success") return "#1a7f37";
  if (tone === "warning") return "#9a6700";
  if (tone === "error") return "#cf222e";
  return "#52463b";
}

const styles: Record<string, CSSProperties> = {
  section: { marginTop: 32 },
  heading: { margin: 0, fontSize: 18 },
  visuallyHidden: {
    position: "absolute",
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    border: 0,
  },
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
  diagnosticFields: {
    display: "grid",
    gridTemplateColumns: "max-content minmax(0, 1fr)",
    gap: "8px 12px",
    margin: "12px 0 0",
    fontSize: 13,
  },
  diagnosticField: {
    display: "contents",
  },
  diagnosticLabel: {
    color: "#6e5f4f",
    fontWeight: 700,
  },
  diagnosticValue: {
    margin: 0,
    minWidth: 0,
    overflowWrap: "anywhere",
  },
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
