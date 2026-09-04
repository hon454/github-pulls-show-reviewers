import type { LocaleSnapshot } from "../../../src/i18n";
import { authErrorKey } from "../auth-presentation";
import type { DeviceFlowController } from "../device-flow-controller";

type Props = {
  locale: LocaleSnapshot;
  controller: DeviceFlowController;
  onCancel: () => void;
};

export function AddAccountPanel({ controller, onCancel, locale }: Props) {
  const { t, lang } = locale;
  const { state } = controller;

  const handleCancel = () => {
    controller.cancel();
    onCancel();
  };

  if (state.phase === "idle" || state.phase === "initiating") {
    return (
      <div
        className="connection-panel connection-panel--loading"
        role="status"
        aria-live="polite"
      >
        {t("auth_requesting")}
      </div>
    );
  }

  if (state.phase === "waiting") {
    return (
      <div className="connection-panel">
        <p className="connection-title">{t("auth_enter_code")}</p>
        <div className="device-code-row">
          <code className="device-code" data-testid="device-user-code">
            {state.userCode}
          </code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(state.userCode);
            }}
            className="button button--secondary"
          >
            {t("auth_copy")}
          </button>
        </div>
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

  if (state.phase === "fetching_installations") {
    return (
      <div
        className="connection-panel connection-panel--loading"
        role="status"
        aria-live="polite"
      >
        {t("auth_loading_installations")}
      </div>
    );
  }

  if (state.phase === "connected") {
    return (
      <div className="connection-panel" role="status" aria-live="polite">
        {t("auth_connected")}
      </div>
    );
  }

  if (state.phase === "expired") {
    return (
      <div className="connection-panel">
        <p role="status" aria-live="polite">
          {t("auth_expired")}
        </p>
        <button
          type="button"
          onClick={controller.start}
          className="button button--primary"
        >
          {t("auth_new_code")}
        </button>
      </div>
    );
  }

  if (state.phase === "denied") {
    return (
      <div className="connection-panel">
        <p role="status" aria-live="polite">
          {t("auth_denied")}
        </p>
        <button
          type="button"
          onClick={controller.start}
          className="button button--primary"
        >
          {t("auth_try_again")}
        </button>
      </div>
    );
  }

  return (
    <div className="connection-panel">
      <p role="status" aria-live="polite">
        {t(authErrorKey(state.code))} <code>{state.code}</code>
      </p>
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
