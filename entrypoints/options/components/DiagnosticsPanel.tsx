import { useEffect, useRef, useState } from "react";

import { diagnoseRepository } from "../../../src/runtime/diagnostics";
import {
  buildRepositoryDiagnostic,
  parseRepositoryInput,
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
  const activeRun = useRef<AbortController | null>(null);
  useEffect(() => () => activeRun.current?.abort(), []);

  async function runDiagnostic(
    execute: (signal: AbortSignal) => Promise<void>,
  ) {
    if (busyRef.current) {
      return;
    }

    busyRef.current = true;
    const controller = new AbortController();
    activeRun.current = controller;
    setBusy(true);
    setDiagnostic({ kind: "running" });
    try {
      await execute(controller.signal);
    } catch {
      if (!controller.signal.aborted)
        setDiagnostic({
          kind: "failed",
          failures: [{ kind: "unknown" }],
        });
    } finally {
      busyRef.current = false;
      activeRun.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function runMatched() {
    if (busyRef.current) return;
    const parsed = parseRepositoryInput(repository);
    if (!parsed) {
      setDiagnostic({ kind: "input-matched" });
      return;
    }
    await runDiagnostic(async (signal) => {
      const result = await diagnoseRepository(
        parsed.owner,
        parsed.name,
        "matched",
        signal,
      );
      if (!signal.aborted) setDiagnostic(result);
    });
  }

  async function runNoToken() {
    if (busyRef.current) return;
    const trimmed = repository.trim();
    if (!trimmed) {
      setDiagnostic({ kind: "input-no-token" });
      return;
    }
    await runDiagnostic(async (signal) => {
      const parsed = parseRepositoryInput(trimmed);
      if (!parsed) {
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
      const result = await diagnoseRepository(
        parsed.owner,
        parsed.name,
        "no-token",
        signal,
      );
      if (!signal.aborted) setDiagnostic(result);
    });
  }

  const inputInvalid =
    state.kind === "input-matched" ||
    state.kind === "input-no-token" ||
    (state.kind === "no-token" &&
      state.result.outcome === "invalid-repository");

  return (
    <section className="settings-section" aria-labelledby="diagnostics-title">
      <div className="section-heading">
        <span className="section-index">03</span>
        <div>
          <h2 id="diagnostics-title">{t("diagnostics_title")}</h2>
          <p>{t("diagnostics_description")}</p>
        </div>
      </div>
      <form
        className="diagnostics-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void runMatched();
        }}
      >
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
          aria-invalid={inputInvalid || undefined}
          aria-describedby={inputInvalid ? "diagnostics-status" : undefined}
        />
        <div className="button-row diagnostic-actions">
          <button
            type="submit"
            aria-disabled={busy || undefined}
            aria-busy={busy || undefined}
            className="button button--primary"
            data-testid="diagnostics-matched"
          >
            {t("diagnostics_check_matched")}
          </button>
          <button
            type="button"
            onClick={() => void runNoToken()}
            aria-disabled={busy || undefined}
            aria-busy={busy || undefined}
            className="button button--secondary"
            data-testid="diagnostics-no-token"
          >
            {t("diagnostics_check_no_token")}
          </button>
        </div>
      </form>
      {diagnostic ? (
        <>
          <p
            id="diagnostics-status"
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
                <div
                  key={`${field.label}\u0000${field.value}`}
                  className="diagnostic-field"
                >
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
