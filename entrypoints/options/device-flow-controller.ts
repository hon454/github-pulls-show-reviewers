import { useCallback, useEffect, useRef, useState } from "react";

import {
  addAccount,
  type Account,
  type Installation,
} from "../../src/storage/accounts";
import {
  DeviceFlowError,
  fetchAuthenticatedUser,
  fetchInstallationRepositories,
  fetchUserInstallations,
  initiateDeviceFlow,
  pollForAccessToken,
  type DeviceFlowInit,
} from "../../src/github/auth";

export type DeviceFlowState =
  | { phase: "idle" }
  | {
      phase: "initiating";
    }
  | {
      phase: "waiting";
      userCode: string;
      verificationUri: string;
      verificationUriComplete: string;
      interval: number;
      expiresAt: number;
    }
  | { phase: "fetching_installations" }
  | { phase: "connected"; accountId: string }
  | { phase: "expired" }
  | { phase: "denied" }
  | { phase: "fatal"; code: string; message: string };

export type DeviceFlowController = {
  state: DeviceFlowState;
  start(): void;
  cancel(): void;
};

export function useDeviceFlowController(input: {
  clientId: string;
  onConnected: (account: Account) => void;
}): DeviceFlowController {
  const [state, setState] = useState<DeviceFlowState>({ phase: "idle" });
  const timerRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);
  const intervalRef = useRef(5);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    clearTimer();
    setState({ phase: "idle" });
  }, [clearTimer]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  const runPollLoop = useCallback(
    (init: DeviceFlowInit, expiresAt: number) => {
      const scheduleNext = () => {
        if (cancelledRef.current) {
          return;
        }
        if (Date.now() >= expiresAt) {
          setState({ phase: "expired" });
          return;
        }
        timerRef.current = window.setTimeout(async () => {
          try {
            const result = await pollForAccessToken({
              clientId: input.clientId,
              deviceCode: init.deviceCode,
            });
            if (cancelledRef.current) {
              return;
            }
            if (result.status === "slow_down") {
              intervalRef.current = Math.max(
                intervalRef.current + 5,
                result.interval || intervalRef.current + 5,
              );
              setState({
                phase: "waiting",
                userCode: init.userCode,
                verificationUri: init.verificationUri,
                verificationUriComplete: init.verificationUriComplete,
                interval: intervalRef.current,
                expiresAt,
              });
              scheduleNext();
              return;
            }
            if (result.status === "pending") {
              scheduleNext();
              return;
            }
            setState({ phase: "fetching_installations" });
            const connected = await completeAccountConnect(
              result,
              input.onConnected,
              () => cancelledRef.current,
            );
            if (!connected || cancelledRef.current) {
              return;
            }
            setState({ phase: "connected", accountId: "pending" });
          } catch (error) {
            if (error instanceof DeviceFlowError) {
              if (error.code === "expired_token") {
                setState({ phase: "expired" });
                return;
              }
              if (error.code === "access_denied") {
                setState({ phase: "denied" });
                return;
              }
              setState({
                phase: "fatal",
                code: error.code,
                message: error.message,
              });
              return;
            }
            setState({
              phase: "fatal",
              code: "network_error",
              message: error instanceof Error ? error.message : "Unknown error",
            });
          }
        }, intervalRef.current * 1000);
      };
      scheduleNext();
    },
    [input.clientId, input.onConnected],
  );

  const start = useCallback(() => {
    cancelledRef.current = false;
    intervalRef.current = 5;
    setState({ phase: "initiating" });
    void (async () => {
      try {
        const init = await initiateDeviceFlow({ clientId: input.clientId });
        if (cancelledRef.current) {
          return;
        }
        intervalRef.current = init.interval;
        const expiresAt = Date.now() + init.expiresIn * 1000;
        setState({
          phase: "waiting",
          userCode: init.userCode,
          verificationUri: init.verificationUri,
          verificationUriComplete: init.verificationUriComplete,
          interval: init.interval,
          expiresAt,
        });
        runPollLoop(init, expiresAt);
      } catch (error) {
        setState({
          phase: "fatal",
          code: "network_error",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    })();
  }, [input.clientId, runPollLoop]);

  return { state, start, cancel };
}

async function completeAccountConnect(
  poll: {
    accessToken: string;
    refreshToken: string | null;
    expiresAt: number | null;
    refreshTokenExpiresAt: number | null;
  },
  onConnected: (account: Account) => void,
  isCancelled: () => boolean,
): Promise<boolean> {
  if (isCancelled()) {
    return false;
  }
  const user = await fetchAuthenticatedUser({ token: poll.accessToken });
  if (isCancelled()) {
    return false;
  }
  const apiInstallations = await fetchUserInstallations({ token: poll.accessToken });
  const installations: Installation[] = await Promise.all(
    apiInstallations.map(async (installation) => {
      const repoFullNames =
        installation.repositorySelection === "selected"
          ? await fetchInstallationRepositories({
              token: poll.accessToken,
              installationId: installation.id,
            })
          : null;
      return {
        id: installation.id,
        account: installation.account,
        repositorySelection: installation.repositorySelection,
        repoFullNames,
      };
    }),
  );
  if (isCancelled()) {
    return false;
  }
  const account: Account = {
    id: globalThis.crypto.randomUUID(),
    login: user.login,
    avatarUrl: user.avatarUrl,
    token: poll.accessToken,
    createdAt: Date.now(),
    installations,
    installationsRefreshedAt: Date.now(),
    invalidated: false,
    invalidatedReason: null,
    refreshToken: poll.refreshToken,
    expiresAt: poll.expiresAt,
    refreshTokenExpiresAt: poll.refreshTokenExpiresAt,
  };
  await addAccount(account);
  if (isCancelled()) {
    return false;
  }
  onConnected(account);
  return true;
}
