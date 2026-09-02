import type { DeviceFlowController } from "../device-flow-controller";

type Props = {
  controller: DeviceFlowController;
  onCancel: () => void;
};

export function AddAccountPanel({ controller, onCancel }: Props) {
  const { state } = controller;

  const handleCancel = () => {
    controller.cancel();
    onCancel();
  };

  if (state.phase === "idle" || state.phase === "initiating") {
    return (
      <div className="connection-panel connection-panel--loading">
        Requesting device code...
      </div>
    );
  }

  if (state.phase === "waiting") {
    return (
      <div className="connection-panel">
        <p className="connection-title">
          Enter this code on GitHub to authorize:
        </p>
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
            Copy
          </button>
        </div>
        <a
          href={state.verificationUriComplete}
          target="_blank"
          rel="noreferrer"
          className="authorization-link"
        >
          Open GitHub to authorize →
        </a>
        <p className="connection-hint connection-hint--waiting">
          Waiting for authorization…
        </p>
        <p className="connection-hint">
          Code expires at {new Date(state.expiresAt).toLocaleTimeString()}.
        </p>
        <button
          type="button"
          onClick={handleCancel}
          className="button button--secondary"
        >
          Cancel
        </button>
      </div>
    );
  }

  if (state.phase === "fetching_installations") {
    return (
      <div className="connection-panel connection-panel--loading">
        Loading your installations…
      </div>
    );
  }

  if (state.phase === "connected") {
    return (
      <div className="connection-panel">
        Account connected. You can add another account or close this panel.
      </div>
    );
  }

  if (state.phase === "expired") {
    return (
      <div className="connection-panel">
        <p>The device code expired.</p>
        <button
          type="button"
          onClick={controller.start}
          className="button button--primary"
        >
          Generate a new code
        </button>
      </div>
    );
  }

  if (state.phase === "denied") {
    return (
      <div className="connection-panel">
        <p>Authorization was denied.</p>
        <button
          type="button"
          onClick={controller.start}
          className="button button--primary"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="connection-panel">
      <p>
        Could not complete sign-in: {state.message} ({state.code}).
      </p>
      <button
        type="button"
        onClick={handleCancel}
        className="button button--secondary"
      >
        Close
      </button>
    </div>
  );
}
