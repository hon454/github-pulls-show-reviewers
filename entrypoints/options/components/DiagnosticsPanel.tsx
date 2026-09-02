import { useRef, useState } from "react";

import { validateRepositoryAccessWithAccount } from "../../../src/auth/account-token-refresh";
import {
  buildMatchedAccountDiagnostic,
  buildNoTokenDiagnostic,
  buildUncoveredAccountDiagnostic,
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
      const resolution = await resolveAccountCoverageForRepo(
        match[1],
        match[2],
      );
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
    <section className="settings-section" aria-labelledby="diagnostics-title">
      <div className="section-heading">
        <span className="section-index">03</span>
        <div>
          <h2 id="diagnostics-title">Repository diagnostics</h2>
          <p>Confirm which access path the extension will use.</p>
        </div>
      </div>
      <label htmlFor="diagnostics-repository" className="field-label">
        Repository <span>owner/name</span>
      </label>
      <input
        id="diagnostics-repository"
        type="text"
        value={repository}
        placeholder="owner/name"
        onChange={(event) => setRepository(event.currentTarget.value)}
        className="text-input"
        data-testid="diagnostics-repo"
      />
      <div className="button-row diagnostic-actions">
        <button
          type="button"
          onClick={() => void runMatched()}
          disabled={busy}
          className="button button--primary"
          data-testid="diagnostics-matched"
        >
          Check matched account
        </button>
        <button
          type="button"
          onClick={() => void runNoToken()}
          disabled={busy}
          className="button button--secondary"
          data-testid="diagnostics-no-token"
        >
          Check no-token path
        </button>
      </div>
      {diagnostic ? (
        <>
          <p
            className={`inline-status inline-status--${diagnostic.tone}`}
            role="status"
            aria-live="polite"
            data-testid="diagnostics-status"
          >
            {diagnostic.message}
          </p>
          {diagnostic.fields.length > 0 ? (
            <dl className="diagnostic-fields" data-testid="diagnostics-fields">
              {diagnostic.fields.map((field) => (
                <div key={field.label} className="diagnostic-field">
                  <dt>{field.label}</dt>
                  <dd
                    className={`diagnostic-value diagnostic-value--${field.tone}`}
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
