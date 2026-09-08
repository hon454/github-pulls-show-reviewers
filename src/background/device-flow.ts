import { z } from "zod";
import {
  DeviceFlowError,
  initiateDeviceFlow,
  pollForAccessToken,
  fetchAuthenticatedUser,
} from "../github/auth";
import { loadAccountInstallations } from "../github/installations";
import { accountMutations, type Account } from "../storage/accounts";
import {
  deviceFlowProgressSchema,
  flowErrorCodeSchema,
  type DeviceFlowProgress,
} from "../runtime/ui-contract";
import { summarizeAccount } from "./account-summary";

const SESSION_KEY = "background:device-flows:v1";
const PROVISIONAL_LIFETIME_MS = 15 * 60_000;
const flowRecordSchema = z.object({
  owner: z.string(),
  attemptId: z.string(),
  flowId: z.string(),
  phase: z.enum([
    "initiating",
    "waiting",
    "polling",
    "committing",
    "connected",
    "cancelled",
    "expired",
    "denied",
    "fatal",
  ]),
  expiresAt: z.number(),
  interval: z.number().positive(),
  nextPollAt: z.number(),
  deviceCode: z.string().optional(),
  userCode: z.string().optional(),
  accountId: z.string().optional(),
  code: flowErrorCodeSchema.optional(),
});
type FlowRecord = z.infer<typeof flowRecordSchema>;
export class FlowOwnershipError extends Error {}

export function createDeviceFlowService(input: {
  ensureReady: () => Promise<void>;
  getClientId: () => string;
  isOwnerAlive: (owner: string) => Promise<boolean>;
  onProgress?: (
    owner: string,
    attemptId: string,
    progress: DeviceFlowProgress,
  ) => void;
  now?: () => number;
}) {
  const now = input.now ?? (() => Date.now());
  let records: FlowRecord[] | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const requests = new Map<string, Promise<DeviceFlowProgress>>();
  const controllers = new Map<string, AbortController>();

  async function save() {
    await browser.storage.session.set({ [SESSION_KEY]: records });
  }
  async function persistTransition(record: FlowRecord): Promise<boolean> {
    try {
      await save();
      return true;
    } catch {
      // No new HTTP/commit may follow an admission whose persistence failed.
      // A possibly written intermediate record restores as restart-required;
      // the current worker must expose that outcome too, never stay polling or
      // committing when the corresponding operation was not actually started.
      terminal(record, "fatal", "restart_required");
      try {
        await save();
      } catch {
        /* Restart reconciliation remains fail-closed. */
      }
      return false;
    }
  }
  function terminal(
    record: FlowRecord,
    phase: "cancelled" | "expired" | "denied" | "fatal",
    code?: FlowRecord["code"],
  ) {
    record.phase = phase;
    delete record.deviceCode;
    delete record.userCode;
    delete record.accountId;
    if (code) record.code = code;
    controllers.get(record.flowId)?.abort();
  }

  async function load() {
    await input.ensureReady();
    if (!records) {
      const raw = await browser.storage.session.get(SESSION_KEY);
      const parsed = z.array(flowRecordSchema).safeParse(raw[SESSION_KEY]);
      records = parsed.success ? parsed.data : [];
      // Ordinary suspension between ticks restores waiting. An interrupted HTTP
      // exchange has an unknown outcome, so it is never automatically replayed.
      for (const record of records) {
        if (record.phase === "initiating" || record.phase === "polling")
          terminal(record, "fatal", "restart_required");
        if (record.phase === "committing") {
          const committed = (await accountMutations.listAccounts()).find(
            (account) => account.connectionAttemptId === record.flowId,
          );
          if (committed) {
            record.phase = "connected";
            record.accountId = committed.id;
            delete record.deviceCode;
            delete record.userCode;
          } else terminal(record, "fatal", "restart_required");
        }
      }
    }
    let changed = false;
    for (const record of records) {
      if (
        (record.phase === "waiting" ||
          record.phase === "initiating" ||
          record.phase === "polling") &&
        record.expiresAt <= now()
      ) {
        terminal(record, "expired");
        changed = true;
      }
    }
    // Retire dead documents, including abandoned flows after a worker restart.
    // Terminal tombstones live only as long as their owner to reject old retries.
    const owners = [...new Set(records.map((record) => record.owner))];
    for (const owner of owners) {
      if (!(await input.isOwnerAlive(owner))) {
        for (const record of records.filter((entry) => entry.owner === owner)) {
          if (record.phase !== "committing") terminal(record, "cancelled");
        }
        records = records.filter(
          (record) => record.owner !== owner || record.phase === "committing",
        );
        changed = true;
      }
    }
    // Persist restoration/retirement even if the next operation is only a read.
    if (changed || rawRestorePending) {
      await save();
      rawRestorePending = false;
    }
  }
  let rawRestorePending = true;

  function ordered<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(async () => {
      await load();
      return operation();
    });
    tail = result.catch(() => undefined);
    return result;
  }
  const find = (owner: string, attemptId: string) =>
    records!.find(
      (record) => record.owner === owner && record.attemptId === attemptId,
    );
  async function progress(
    record: FlowRecord | undefined,
  ): Promise<DeviceFlowProgress> {
    if (!record) return { phase: "fatal", code: "restart_required" };
    if (record.phase === "waiting")
      return deviceFlowProgressSchema.parse({
        phase: "waiting",
        flowId: record.flowId,
        userCode: record.userCode,
        verificationUri: "https://github.com/login/device",
        verificationUriComplete: `https://github.com/login/device?user_code=${encodeURIComponent(record.userCode!)}`,
        interval: record.interval,
        expiresAt: record.expiresAt,
        nextPollAt: record.nextPollAt,
      });
    if (record.phase === "polling") return { phase: "fetching_installations" };
    if (record.phase === "connected") {
      const account = await accountMutations.getAccountById(record.accountId!);
      return account
        ? { phase: "connected", account: summarizeAccount(account) }
        : { phase: "fatal", code: "restart_required" };
    }
    if (record.phase === "fatal")
      return { phase: "fatal", code: record.code ?? "unknown_error" };
    return { phase: record.phase };
  }
  function notify(record: FlowRecord, value: DeviceFlowProgress) {
    input.onProgress?.(
      record.owner,
      record.attemptId,
      deviceFlowProgressSchema.parse(value),
    );
  }
  async function failed(
    owner: string,
    attemptId: string,
    error: unknown,
  ): Promise<DeviceFlowProgress> {
    return ordered(async () => {
      const record = find(owner, attemptId);
      if (!record || !["initiating", "polling"].includes(record.phase))
        return progress(record);
      if (error instanceof DeviceFlowError && error.code === "expired_token")
        terminal(record, "expired");
      else if (
        error instanceof DeviceFlowError &&
        error.code === "access_denied"
      )
        terminal(record, "denied");
      else {
        const code = flowErrorCodeSchema.safeParse(
          error instanceof DeviceFlowError ? error.code : "unknown_error",
        );
        terminal(record, "fatal", code.success ? code.data : "unknown_error");
      }
      await save();
      return progress(record);
    });
  }
  function dedupe(
    key: string,
    run: () => Promise<DeviceFlowProgress>,
  ): Promise<DeviceFlowProgress> {
    const pending = requests.get(key);
    if (pending) return pending;
    const operation = run().finally(() => {
      if (requests.get(key) === operation) requests.delete(key);
    });
    requests.set(key, operation);
    return operation;
  }

  return {
    initialize: () => ordered(async () => {}),
    retireOwner(owner: string) {
      return ordered(async () => {
        for (const record of records!.filter(
          (entry) => entry.owner === owner,
        )) {
          if (record.phase !== "committing") terminal(record, "cancelled");
        }
        await save();
      });
    },
    start(owner: string, attemptId: string): Promise<DeviceFlowProgress> {
      return dedupe(`start:${owner}:${attemptId}`, async () => {
        const admission = await ordered(async () => {
          const existing = find(owner, attemptId);
          if (existing) return { result: await progress(existing) };
          if (!(await input.isOwnerAlive(owner)))
            throw new FlowOwnershipError();
          // A new attempt supersedes older cancellable work from this document.
          for (const record of records!.filter(
            (entry) => entry.owner === owner,
          )) {
            if (["initiating", "waiting", "polling"].includes(record.phase))
              terminal(record, "cancelled");
          }
          const record: FlowRecord = {
            owner,
            attemptId,
            flowId: crypto.randomUUID(),
            phase: "initiating",
            expiresAt: now() + PROVISIONAL_LIFETIME_MS,
            interval: 5,
            nextPollAt: now(),
          };
          records!.push(record);
          if (!(await persistTransition(record)))
            return { result: await progress(record) };
          const controller = new AbortController();
          controllers.set(record.flowId, controller);
          return { record, controller };
        });
        if (admission.result) return admission.result;
        const { record, controller } = admission;
        try {
          const init = await initiateDeviceFlow({
            clientId: input.getClientId(),
            signal: controller!.signal,
          });
          return await ordered(async () => {
            const current = find(owner, attemptId);
            if (current?.phase !== "initiating") return progress(current);
            if (
              init.verificationUri !== "https://github.com/login/device" ||
              !Number.isFinite(init.expiresIn) ||
              init.expiresIn <= 0 ||
              !Number.isFinite(init.interval) ||
              init.interval <= 0
            ) {
              throw new DeviceFlowError("invalid_response");
            }
            current.phase = "waiting";
            current.deviceCode = init.deviceCode;
            current.userCode = init.userCode;
            current.interval = init.interval;
            current.expiresAt = now() + init.expiresIn * 1000;
            current.nextPollAt = now() + init.interval * 1000;
            await persistTransition(current);
            return progress(current);
          });
        } catch (error) {
          return failed(owner, attemptId, error);
        } finally {
          controllers.delete(record!.flowId);
        }
      });
    },
    cancel(owner: string, attemptId: string): Promise<DeviceFlowProgress> {
      return ordered(async () => {
        let record = find(owner, attemptId);
        if (!record) {
          if (records!.some((entry) => entry.attemptId === attemptId))
            throw new FlowOwnershipError();
          // Cancel can beat initiation admission. Preserve a non-secret tombstone.
          record = {
            owner,
            attemptId,
            flowId: crypto.randomUUID(),
            phase: "cancelled",
            expiresAt: now() + PROVISIONAL_LIFETIME_MS,
            interval: 5,
            nextPollAt: now(),
          };
          records!.push(record);
        }
        if (record.phase !== "committing" && record.phase !== "connected")
          terminal(record, "cancelled");
        await save(); // ACK only after the cancellation has become restart-safe.
        return progress(record);
      });
    },
    poll(
      owner: string,
      attemptId: string,
      flowId: string,
    ): Promise<DeviceFlowProgress> {
      return dedupe(`poll:${owner}:${attemptId}:${flowId}`, async () => {
        const admission = await ordered(async () => {
          const record = find(owner, attemptId);
          if (!record) {
            if (records!.some((entry) => entry.flowId === flowId))
              throw new FlowOwnershipError();
            return {
              result: {
                phase: "fatal",
                code: "restart_required",
              } as DeviceFlowProgress,
            };
          }
          if (record.flowId !== flowId) throw new FlowOwnershipError();
          if (record.phase !== "waiting" || record.nextPollAt > now())
            return { result: await progress(record) };
          record.phase = "polling";
          record.nextPollAt = now() + record.interval * 1000;
          // Admission and minimum interval precede HTTP.
          if (!(await persistTransition(record)))
            return { result: await progress(record) };
          const controller = new AbortController();
          controllers.set(flowId, controller);
          return { record, controller };
        });
        if (admission.result) return admission.result;
        const { record, controller } = admission;
        try {
          if (controller!.signal.aborted)
            return ordered(() => progress(find(owner, attemptId)));
          const result = await pollForAccessToken({
            clientId: input.getClientId(),
            deviceCode: record!.deviceCode!,
            signal: controller!.signal,
          });
          if (result.status !== "success")
            return await ordered(async () => {
              const current = find(owner, attemptId);
              if (current?.phase !== "polling") return progress(current);
              if (result.status === "slow_down")
                current.interval = Math.max(
                  current.interval + 5,
                  result.interval || 0,
                );
              current.phase = "waiting";
              current.nextPollAt = now() + current.interval * 1000;
              await persistTransition(current);
              return progress(current);
            });
          const active = await ordered(
            async () => find(owner, attemptId)?.phase === "polling",
          );
          if (!active || controller!.signal.aborted)
            return ordered(() => progress(find(owner, attemptId)));
          notify(record!, { phase: "fetching_installations" });
          const user = await fetchAuthenticatedUser({
            token: result.accessToken,
            signal: controller!.signal,
          });
          if (controller!.signal.aborted)
            return ordered(() => progress(find(owner, attemptId)));
          const installations = await loadAccountInstallations({
            token: result.accessToken,
            signal: controller!.signal,
          });
          const commit = await ordered(
            async (): Promise<
              { result: DeviceFlowProgress } | { commit: Promise<Account> }
            > => {
              const current = find(owner, attemptId);
              if (current?.phase !== "polling")
                return { result: await progress(current) };
              if (!(await input.isOwnerAlive(owner))) {
                terminal(current, "cancelled");
                await save();
                return { result: { phase: "cancelled" } };
              }
              current.phase = "committing";
              delete current.deviceCode;
              delete current.userCode;
              if (!(await persistTransition(current)))
                return { result: await progress(current) };
              // The same ordered owner admits cancellation and this final write.
              // Do not return a cancellation ACK after admission, or undo a later
              // account by deleting it. Registry identity remains #166's concern.
              const committing = accountMutations.upsertAccountByLogin({
                login: user.login,
                avatarUrl: user.avatarUrl,
                token: result.accessToken,
                refreshToken: result.refreshToken,
                expiresAt: result.expiresAt,
                refreshTokenExpiresAt: result.refreshTokenExpiresAt,
                installations,
                newAccountId: crypto.randomUUID(),
                now: now(),
                connectionAttemptId: flowId,
              });
              notify(current, { phase: "committing" });
              return { commit: committing };
            },
          );
          if ("result" in commit) return commit.result;
          let account: Account;
          try {
            account = await commit.commit;
          } catch {
            // A failed write may be uncertain. Never replay the commit. On a
            // restored worker the atomic receipt can still establish completion.
            return ordered(async () => {
              const current = find(owner, attemptId);
              if (current) {
                terminal(current, "fatal", "restart_required");
                await save();
              }
              return progress(current);
            });
          }
          return await ordered(async () => {
            const current = find(owner, attemptId);
            if (!current) return { phase: "fatal", code: "restart_required" };
            current.phase = "connected";
            current.accountId = account.id;
            await save();
            return { phase: "connected", account: summarizeAccount(account) };
          });
        } catch (error) {
          return failed(owner, attemptId, error);
        } finally {
          controllers.delete(flowId);
        }
      });
    },
  };
}
