import { useEffect, useRef, useState, type RefObject } from "react";

import type { LocaleSnapshot } from "../../../src/i18n";
import { authErrorKey } from "../auth-presentation";
import type { DeviceFlowController } from "../device-flow-controller";

type Props = {
  locale: LocaleSnapshot;
  controller: DeviceFlowController;
  onCancel: (restoreFocus: boolean) => void;
  panelRef?: RefObject<HTMLDivElement | null>;
};

type CopyFeedback =
  | { phase: "idle"; code: null }
  | { phase: "copying" | "copied" | "copy-failed"; code: string };

export function AddAccountPanel({
  controller,
  onCancel,
  locale,
  panelRef,
}: Props) {
  const { t, lang } = locale;
  const { state } = controller;
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback>({
    phase: "idle",
    code: null,
  });
  const copyRequest = useRef(0);
  const copyGeneration = useRef(0);
  const copyInFlight = useRef<number | null>(null);
  const currentCode = useRef<string | null>(null);
  const localPanelRef = useRef<HTMLDivElement | null>(null);
  const focusTarget = panelRef ?? localPanelRef;

  // This is intentionally mount-only. A locale or device-flow progress update
  // must keep the user's current focus where it is.
  useEffect(() => {
    focusTarget.current?.focus();
  }, [focusTarget]);

  useEffect(
    () => () => {
      copyRequest.current += 1;
      copyGeneration.current += 1;
    },
    [],
  );

  const displayedCode = state.phase === "waiting" ? state.userCode : null;
  if (currentCode.current !== displayedCode) {
    currentCode.current = displayedCode;
    copyGeneration.current += 1;
  }

  const handleCancel = () => {
    const focusWasInside =
      focusTarget.current?.contains(document.activeElement) === true;
    void controller.cancel().then((cancelled) => {
      if (cancelled) onCancel(focusWasInside);
    });
  };

  const handleRetry = () => {
    // Retry is a user-initiated replacement, so return focus to the stable
    // panel region. Routine progress updates deliberately do not do this.
    focusTarget.current?.focus();
    controller.start();
  };

  const handleCopy = async (userCode: string) => {
    const generation = copyGeneration.current;
    if (copyInFlight.current === generation) return;

    const request = ++copyRequest.current;
    copyInFlight.current = generation;
    setCopyFeedback({ phase: "copying", code: userCode });
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard_missing");
      await navigator.clipboard.writeText(userCode);
      if (
        copyGeneration.current === generation &&
        currentCode.current === userCode
      ) {
        setCopyFeedback({ phase: "copied", code: userCode });
      }
    } catch {
      if (
        copyGeneration.current === generation &&
        currentCode.current === userCode
      ) {
        setCopyFeedback({ phase: "copy-failed", code: userCode });
      }
    } finally {
      if (copyRequest.current === request) copyInFlight.current = null;
    }
  };

  const panelProps = {
    ref: focusTarget,
    tabIndex: -1,
    "data-testid": "add-account-panel",
    "aria-label": t("options_add_account"),
  };

  if (
    state.phase === "idle" ||
    state.phase === "initiating" ||
    state.phase === "cancelling"
  ) {
    return (
      <div
        {...panelProps}
        className="connection-panel connection-panel--loading"
      >
        <p role="status" aria-live="polite">
          {t(
            state.phase === "cancelling"
              ? "auth_cancelling"
              : "auth_requesting",
          )}
        </p>
      </div>
    );
  }

  if (state.phase === "waiting") {
    return (
      <div {...panelProps} className="connection-panel">
        <p className="connection-title">{t("auth_enter_code")}</p>
        <div className="device-code-row">
          <code className="device-code" data-testid="device-user-code">
            {state.userCode}
          </code>
          <button
            type="button"
            onClick={() => void handleCopy(state.userCode)}
            className="button button--secondary"
            disabled={
              copyFeedback.phase === "copying" &&
              copyFeedback.code === state.userCode
            }
          >
            {copyFeedback.phase === "copying" &&
            copyFeedback.code === state.userCode
              ? t("auth_copying")
              : t("auth_copy")}
          </button>
        </div>
        <p
          className="connection-hint"
          data-testid="clipboard-feedback"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {copyFeedback.code === state.userCode &&
          copyFeedback.phase !== "copying"
            ? t(
                copyFeedback.phase === "copied"
                  ? "auth_code_copied"
                  : "auth_code_copy_failed",
              )
            : null}
        </p>
        <a
          href={state.verificationUriComplete}
          target="_blank"
          rel="noreferrer"
          className="authorization-link"
        >
          {t("auth_open_github")}
        </a>
        <p
          className="connection-hint connection-hint--waiting"
          role="status"
          aria-live="polite"
        >
          {t("auth_waiting")}
        </p>
        <p className="connection-hint">
          {t("auth_expires_at", {
            time: new Date(state.expiresAt).toLocaleTimeString(lang),
          })}
        </p>
        <button
          type="button"
          onClick={handleCancel}
          className="button button--secondary"
        >
          {t("auth_cancel")}
        </button>
      </div>
    );
  }

  if (
    state.phase === "fetching_installations" ||
    state.phase === "committing"
  ) {
    return (
      <div
        {...panelProps}
        className="connection-panel connection-panel--loading"
      >
        <p role="status" aria-live="polite">
          {t("auth_loading_installations")}
        </p>
      </div>
    );
  }

  if (state.phase === "connected") {
    return (
      <div
        {...panelProps}
        className="connection-panel"
        role="status"
        aria-live="polite"
      >
        {t("auth_connected")}
      </div>
    );
  }

  if (state.phase === "expired") {
    return (
      <div {...panelProps} className="connection-panel">
        <p role="status" aria-live="polite">
          {t("auth_expired")}
        </p>
        <button
          type="button"
          onClick={handleRetry}
          className="button button--primary"
        >
          {t("auth_new_code")}
        </button>
      </div>
    );
  }

  if (state.phase === "denied") {
    return (
      <div {...panelProps} className="connection-panel">
        <p role="status" aria-live="polite">
          {t("auth_denied")}
        </p>
        <button
          type="button"
          onClick={handleRetry}
          className="button button--primary"
        >
          {t("auth_try_again")}
        </button>
      </div>
    );
  }

  if (state.phase !== "fatal") return null;
  return (
    <div {...panelProps} className="connection-panel">
      <p role="status" aria-live="polite">
        {t(authErrorKey(state.code))} <code>{state.code}</code>
      </p>
      {state.code === "restart_required" ? (
        <button
          type="button"
          onClick={handleRetry}
          className="button button--primary"
        >
          {t("auth_new_code")}
        </button>
      ) : null}
      <button
        type="button"
        onClick={handleCancel}
        className="button button--secondary"
      >
        {t("auth_close")}
      </button>
    </div>
  );
}
