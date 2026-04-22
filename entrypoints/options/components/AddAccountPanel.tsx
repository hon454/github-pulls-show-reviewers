import { useEffect, useRef, type CSSProperties } from "react";

import { getGitHubAppConfig } from "../../../src/config/github-app";
import type { Account } from "../../../src/storage/accounts";

import { useDeviceFlowController } from "../device-flow-controller";

type Props = {
  onConnected: (account: Account) => void;
  onCancel: () => void;
};

export function AddAccountPanel({ onConnected, onCancel }: Props) {
  const appConfig = getGitHubAppConfig();
  const controller = useDeviceFlowController({
    clientId: appConfig.clientId,
    onConnected,
  });
  const { state } = controller;

  const startedRef = useRef(false);
  // Start the flow exactly once on mount; ref guards against re-firing because `controller` identity churns on every render.
  useEffect(() => {
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;
    controller.start();
  }, [controller]);

  if (state.phase === "idle" || state.phase === "initiating") {
    return <div style={styles.panel}>Requesting device code...</div>;
  }

  if (state.phase === "waiting") {
    return (
      <div style={styles.panel}>
        <p style={styles.title}>Enter this code on GitHub to authorize:</p>
        <div style={styles.codeRow}>
          <code style={styles.code} data-testid="device-user-code">
            {state.userCode}
          </code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(state.userCode);
            }}
            style={styles.secondaryButton}
          >
            Copy
          </button>
        </div>
        <a
          href={state.verificationUriComplete}
          target="_blank"
          rel="noreferrer"
          style={styles.primaryLink}
        >
          Open GitHub to authorize →
        </a>
        <p style={styles.hint}>Waiting for authorization…</p>
        <p style={styles.hint}>
          Code expires at {new Date(state.expiresAt).toLocaleTimeString()}.
        </p>
        <button
          type="button"
          onClick={() => {
            controller.cancel();
            onCancel();
          }}
          style={styles.secondaryButton}
        >
          Cancel
        </button>
      </div>
    );
  }

  if (state.phase === "fetching_installations") {
    return <div style={styles.panel}>Loading your installations…</div>;
  }

  if (state.phase === "connected") {
    return (
      <div style={styles.panel}>
        Account connected. You can add another account or close this panel.
      </div>
    );
  }

  if (state.phase === "expired") {
    return (
      <div style={styles.panel}>
        <p>The device code expired.</p>
        <button type="button" onClick={controller.start} style={styles.primaryButton}>
          Generate a new code
        </button>
      </div>
    );
  }

  if (state.phase === "denied") {
    return (
      <div style={styles.panel}>
        <p>Authorization was denied.</p>
        <button type="button" onClick={controller.start} style={styles.primaryButton}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div style={styles.panel}>
      <p>
        Could not complete sign-in: {state.message} ({state.code}).
      </p>
      <button
        type="button"
        onClick={() => {
          controller.cancel();
          onCancel();
        }}
        style={styles.secondaryButton}
      >
        Close
      </button>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  panel: {
    padding: 16,
    borderRadius: 16,
    background: "#fffdf9",
    border: "1px solid rgba(34, 29, 24, 0.08)",
    display: "grid",
    gap: 12,
  },
  title: { margin: 0, fontWeight: 600 },
  codeRow: { display: "flex", gap: 12, alignItems: "center" },
  code: {
    padding: "8px 12px",
    background: "#f6f8fa",
    borderRadius: 8,
    fontSize: 18,
    letterSpacing: "0.1em",
  },
  primaryLink: {
    color: "#1f6feb",
    fontWeight: 600,
    textDecoration: "none",
  },
  hint: { margin: 0, color: "#52463b", fontSize: 13 },
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
};
