import { useRef, useState } from "react";

import { diagnoseRepository } from "../../../src/runtime/diagnostics";
import {
  buildRepositoryDiagnostic,
  type RepositoryDiagnosticState,
} from "../../../src/features/repository-diagnostics";
import type { Translator } from "../../../src/i18n";

export function DiagnosticsPanel({ t }: { t: Translator }) {
  const [repository, setRepository] = useState("");
  const [state, setDiagnostic] = useState<RepositoryDiagnosticState>({
    kind: "empty",
  });
  const diagnostic = buildRepositoryDiagnostic(state, t);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  async function runDiagnostic(execute: () => Promise<void>) {
    if (busyRef.current) {
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setDiagnostic({ kind: "running" });
    try {
      await execute();
    } catch {
      setDiagnostic({
        kind: "failed",
        failures: [{ kind: "unknown" }],
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
      setDiagnostic({ kind: "input-matched" });
      return;
    }
    await runDiagnostic(async () => {
      setDiagnostic(await diagnoseRepository(match[1], match[2], "matched"));
    });
  }

  async function runNoToken() {
    const trimmed = repository.trim();
    if (!trimmed) {
      setDiagnostic({ kind: "input-no-token" });
      return;
    }
    await runDiagnostic(async () => {
      const normalized = trimmed
        .replace(/^https:\/\/github\.com\//, "")
        .replace(/\/+$/, "");
      const match = normalized.match(/^([^/\s]+)\/([^/\s]+)$/);
      if (!match) {
        setDiagnostic({
          kind: "no-token",
          repository: trimmed,
          result: {
            ok: false,
            authMode: "no-token",
            outcome: "invalid-repository",
          },
        });
        return;
      }
      setDiagnostic(await diagnoseRepository(match[1], match[2], "no-token"));
    });
  }

  return (
    <section className="settings-section" aria-labelledby="diagnostics-title">
      <div className="section-heading">
        <span className="section-index">03</span>
        <div>
          <h2 id="diagnostics-title">{t("diagnostics_title")}</h2>
          <p>{t("diagnostics_description")}</p>
        </div>
      </div>
      <label htmlFor="diagnostics-repository" className="field-label">
        {t("diagnostics_repository")} <span>owner/name</span>
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
          {t("diagnostics_check_matched")}
        </button>
        <button
          type="button"
          onClick={() => void runNoToken()}
          disabled={busy}
          className="button button--secondary"
          data-testid="diagnostics-no-token"
        >
          {t("diagnostics_check_no_token")}
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
              {diagnostic.fields.map((field, index) => (
                <div key={index} className="diagnostic-field">
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
