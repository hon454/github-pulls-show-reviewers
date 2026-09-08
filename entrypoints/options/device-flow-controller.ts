import { useCallback, useEffect, useRef, useState } from "react";
import { getUIClient, requestCapability } from "../../src/runtime/ui-client";
import {
  deviceFlowProgressSchema,
  type AccountSummary,
  type DeviceFlowProgress,
} from "../../src/runtime/ui-contract";

export type DeviceFlowState =
  | {
      phase:
        | "idle"
        | "initiating"
        | "cancelling"
        | "fetching_installations"
        | "committing";
    }
  | {
      phase: "waiting";
      userCode: string;
      verificationUri: string;
      verificationUriComplete: string;
      interval: number;
      expiresAt: number;
    }
  | { phase: "connected"; accountId: string }
  | { phase: "expired" | "denied" }
  | { phase: "fatal"; code: string };
export type DeviceFlowController = {
  state: DeviceFlowState;
  start(): void;
  cancel(): Promise<boolean>;
};
type Attempt = {
  id: string;
  flowId?: string;
  timer: number | null;
  completed: boolean;
  cancelling?: boolean;
  latestProgress?: DeviceFlowProgress;
};

export function useDeviceFlowController(input: {
  onConnected: (account: AccountSummary) => void;
}): DeviceFlowController {
  const [state, setState] = useState<DeviceFlowState>({ phase: "idle" });
  const attemptRef = useRef<Attempt | null>(null);
  const mounted = useRef(false);
  const onConnected = useRef(input.onConnected);
  onConnected.current = input.onConnected;
  const isCurrent = useCallback(
    (attempt: Attempt) => mounted.current && attemptRef.current === attempt,
    [],
  );
  const detach = useCallback(() => {
    const attempt = attemptRef.current;
    attemptRef.current = null;
    if (attempt?.timer != null) window.clearTimeout(attempt.timer);
    if (attempt) attempt.timer = null;
    return attempt;
  }, []);
  const cancelRequest = useCallback(
    (attempt: Attempt) =>
      requestCapability(
        { type: "cancelDeviceFlow", attemptId: attempt.id },
        deviceFlowProgressSchema,
      ),
    [],
  );

  const apply = useCallback(
    (attempt: Attempt, progress: DeviceFlowProgress) => {
      if (!isCurrent(attempt)) return;
      if (attempt.cancelling) {
        attempt.latestProgress = progress;
        return;
      }
      if (progress.phase === "connected") {
        if (attempt.completed) return;
        attempt.completed = true;
        setState({ phase: "connected", accountId: progress.account.id });
        onConnected.current(progress.account);
      } else if (progress.phase === "cancelled") setState({ phase: "idle" });
      else setState(progress);
    },
    [isCurrent],
  );

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = getUIClient().subscribeFlows((attemptId, progress) => {
      const attempt = attemptRef.current;
      if (attempt?.id === attemptId) apply(attempt, progress);
    });
    return () => {
      mounted.current = false;
      unsubscribe();
      const attempt = detach();
      if (attempt) void cancelRequest(attempt).catch(() => undefined);
    };
  }, [apply, cancelRequest, detach]);

  const cancel = useCallback(async () => {
    const attempt = attemptRef.current;
    if (!attempt) {
      if (mounted.current) setState({ phase: "idle" });
      return true;
    }
    if (attempt.timer != null) window.clearTimeout(attempt.timer);
    attempt.timer = null;
    attempt.cancelling = true;
    if (mounted.current) setState({ phase: "cancelling" });
    try {
      const progress = await cancelRequest(attempt);
      if (!isCurrent(attempt)) return false;
      attempt.cancelling = false;
      if (progress.phase === "committing" || progress.phase === "connected") {
        apply(
          attempt,
          attempt.latestProgress?.phase === "connected"
            ? attempt.latestProgress
            : progress,
        );
        return false;
      }
      detach();
      setState({ phase: "idle" });
      return true;
    } catch {
      attempt.cancelling = false;
      if (isCurrent(attempt))
        setState({ phase: "fatal", code: "network_error" });
      return false;
    }
  }, [apply, cancelRequest, detach, isCurrent]);

  const start = useCallback(() => {
    const previous = detach();
    if (previous) void cancelRequest(previous).catch(() => undefined);
    if (!mounted.current) return;
    // Created before initiation awaits: cancel never needs the server flow ID.
    const attempt: Attempt = {
      id: crypto.randomUUID(),
      timer: null,
      completed: false,
    };
    attemptRef.current = attempt;
    setState({ phase: "initiating" });

    const schedule = (
      waiting: Extract<DeviceFlowProgress, { phase: "waiting" }>,
    ) => {
      if (!isCurrent(attempt)) return;
      attempt.flowId = waiting.flowId;
      attempt.timer = window.setTimeout(
        async () => {
          attempt.timer = null;
          if (!isCurrent(attempt)) return;
          if (Date.now() >= waiting.expiresAt) {
            setState({ phase: "expired" });
            void cancelRequest(attempt).catch(() => undefined);
            return;
          }
          try {
            const progress = await requestCapability(
              {
                type: "pollDeviceFlow",
                attemptId: attempt.id,
                flowId: waiting.flowId,
              },
              deviceFlowProgressSchema,
            );
            if (!isCurrent(attempt)) return;
            apply(attempt, progress);
            if (progress.phase === "waiting") schedule(progress);
          } catch {
            if (isCurrent(attempt))
              setState({ phase: "fatal", code: "network_error" });
          }
        },
        Math.max(
          1,
          Math.min(waiting.nextPollAt, waiting.expiresAt) - Date.now(),
        ),
      );
    };
    void requestCapability(
      { type: "startDeviceFlow", attemptId: attempt.id },
      deviceFlowProgressSchema,
    ).then(
      (progress) => {
        if (!isCurrent(attempt)) return;
        apply(attempt, progress);
        if (progress.phase === "waiting") schedule(progress);
      },
      () => {
        if (isCurrent(attempt))
          setState({ phase: "fatal", code: "network_error" });
      },
    );
  }, [apply, cancelRequest, detach, isCurrent]);
  return { state, start, cancel };
}
