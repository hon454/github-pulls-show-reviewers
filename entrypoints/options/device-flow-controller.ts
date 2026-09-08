import { useCallback, useEffect, useRef, useState } from "react";

import type { Account } from "../../src/storage/accounts";
import { upsertAccountByLogin } from "../../src/runtime/account-mutations";
import {
  DeviceFlowError,
  fetchAuthenticatedUser,
  initiateDeviceFlow,
  pollForAccessToken,
  type DeviceFlowInit,
} from "../../src/github/auth";
import { loadAccountInstallations } from "../../src/github/installations";

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
  | { phase: "fatal"; code: string };

export type DeviceFlowController = {
  state: DeviceFlowState;
  start(): void;
  cancel(): void;
};

type DeviceFlowAttempt = {
  controller: AbortController;
  timer: number | null;
  interval: number;
  expiresAt: number;
};

export function useDeviceFlowController(input: {
  clientId: string;
  onConnected: (account: Account) => void;
}): DeviceFlowController {
  const [state, setState] = useState<DeviceFlowState>({ phase: "idle" });
  const attemptRef = useRef<DeviceFlowAttempt | null>(null);
  const mountedRef = useRef(false);

  const invalidateAttempt = useCallback(() => {
    const attempt = attemptRef.current;
    attemptRef.current = null;
    if (attempt) {
      if (attempt.timer != null) window.clearTimeout(attempt.timer);
      attempt.timer = null;
      attempt.controller.abort();
    }
  }, []);

  const isCurrent = useCallback(
    (attempt: DeviceFlowAttempt) =>
      mountedRef.current && attemptRef.current === attempt,
    [],
  );

  const cancel = useCallback(() => {
    invalidateAttempt();
    if (mountedRef.current) setState({ phase: "idle" });
  }, [invalidateAttempt]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      invalidateAttempt();
    };
  }, [invalidateAttempt]);

  const runPollLoop = useCallback(
    (attempt: DeviceFlowAttempt, init: DeviceFlowInit) => {
      const scheduleNext = () => {
        if (!isCurrent(attempt)) {
          return;
        }
        if (Date.now() >= attempt.expiresAt) {
          setState({ phase: "expired" });
          return;
        }
        attempt.timer = window.setTimeout(async () => {
          attempt.timer = null;
          if (!isCurrent(attempt)) return;
          if (Date.now() >= attempt.expiresAt) {
            setState({ phase: "expired" });
            return;
          }
          try {
            const result = await pollForAccessToken({
              clientId: input.clientId,
              deviceCode: init.deviceCode,
              signal: attempt.controller.signal,
            });
            if (!isCurrent(attempt)) {
              return;
            }
            if (result.status === "slow_down") {
              attempt.interval = Math.max(
                attempt.interval + 5,
                result.interval || attempt.interval + 5,
              );
              setState({
                phase: "waiting",
                userCode: init.userCode,
                verificationUri: init.verificationUri,
                verificationUriComplete: init.verificationUriComplete,
                interval: attempt.interval,
                expiresAt: attempt.expiresAt,
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
              () => isCurrent(attempt),
              attempt.controller.signal,
            );
            if (!connected || !isCurrent(attempt)) {
              return;
            }
            setState({ phase: "connected", accountId: "pending" });
          } catch (error) {
            if (!isCurrent(attempt)) return;
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
              });
              return;
            }
            setState({
              phase: "fatal",
              code: "unknown_error",
            });
          }
        }, attempt.interval * 1000);
      };
      scheduleNext();
    },
    [input.clientId, input.onConnected, isCurrent],
  );

  const start = useCallback(() => {
    invalidateAttempt();
    if (!mountedRef.current) return;
    const attempt: DeviceFlowAttempt = {
      controller: new AbortController(),
      timer: null,
      interval: 5,
      expiresAt: 0,
    };
    attemptRef.current = attempt;
    setState({ phase: "initiating" });
    void (async () => {
      try {
        const init = await initiateDeviceFlow({
          clientId: input.clientId,
          signal: attempt.controller.signal,
        });
        if (!isCurrent(attempt)) {
          return;
        }
        attempt.interval = init.interval;
        attempt.expiresAt = Date.now() + init.expiresIn * 1000;
        setState({
          phase: "waiting",
          userCode: init.userCode,
          verificationUri: init.verificationUri,
          verificationUriComplete: init.verificationUriComplete,
          interval: init.interval,
          expiresAt: attempt.expiresAt,
        });
        runPollLoop(attempt, init);
      } catch (error) {
        if (!isCurrent(attempt)) return;
        setState({
          phase: "fatal",
          code: error instanceof DeviceFlowError ? error.code : "unknown_error",
        });
      }
    })();
  }, [input.clientId, runPollLoop, invalidateAttempt, isCurrent]);

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
  isCurrent: () => boolean,
  signal: AbortSignal,
): Promise<boolean> {
  if (!isCurrent()) {
    return false;
  }
  const user = await fetchAuthenticatedUser({
    token: poll.accessToken,
    signal,
  });
  if (!isCurrent()) {
    return false;
  }
  const installations = await loadAccountInstallations({
    token: poll.accessToken,
    signal,
  });
  if (!isCurrent()) {
    return false;
  }
  // Admission is the cancellation boundary: the background owns this write.
  // Once started it may commit; never roll it back on behalf of a stale attempt.
  const account = await upsertAccountByLogin({
    login: user.login,
    avatarUrl: user.avatarUrl,
    token: poll.accessToken,
    refreshToken: poll.refreshToken,
    expiresAt: poll.expiresAt,
    refreshTokenExpiresAt: poll.refreshTokenExpiresAt,
    installations,
    newAccountId: globalThis.crypto.randomUUID(),
    now: Date.now(),
  });
  if (!isCurrent()) {
    return false;
  }
  onConnected(account);
  return true;
}
