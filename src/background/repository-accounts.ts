import {
  createReviewerDeadline,
  REVIEWER_DEADLINES,
  ReviewerTimeoutError,
  reviewerAbortReason,
  throwIfReviewerAborted,
  withReviewerDeadline,
} from "../shared/reviewer-deadline";
import type { RefreshCoordinator } from "../auth/refresh-coordinator";
import {
  fetchPullReviewerMetadataBatch,
  fetchPullReviewerSummary,
  type PullReviewerMetadata,
} from "../github/api";
import {
  accountMutations,
  credentialGeneration,
  type Account,
} from "../storage/accounts";
import {
  ReviewerFetchRuntimeError,
  serializeReviewerFetchError,
  type ReviewerFetchErrorEnvelope,
} from "../runtime/reviewer-fetch";
import type { AccountSummary } from "../runtime/ui-contract";
import type { RepositoryDiscovery } from "../runtime/repository-discovery";
import { createSelfHealingAccountResolver } from "./account-resolution";
import { summarizeAccount } from "./account-summary";
import {
  abortError,
  accountAccessKey,
  accountAccessRevision,
  classifyAuthenticatedFailure,
  createAccountRequest,
  waitWithSignal,
} from "./account-request";
import { orderRepositoryCandidates } from "./repository-account-policy";
import {
  createRepositoryDiscoveryLedger,
  DiscoveryUnavailableError,
  type DiscoveryOwner,
  type DiscoveryRecord,
} from "./repository-discovery-ledger";
import type { InstallationRefreshService } from "./installation-refresh";

type Access = {
  account: AccountSummary | null;
  metadata: PullReviewerMetadata[] | undefined;
  accessKey?: string | undefined;
  fresh?: boolean;
};
type Operation = {
  controller: AbortController;
  subscribers: Set<object>;
  accounts: Map<string, string>;
  accountId: string | null;
  account: AccountSummary | null;
  lastFailure?: ReviewerFetchErrorEnvelope | undefined;
  promise: Promise<Access>;
};
const METADATA_FRESH_MS = 10_000;

/** One owner for repository discovery; ordinary summary HTTP remains caller-owned. */
export function createRepositoryAccountService(input: {
  ensureReady: () => Promise<void>;
  coordinator: RefreshCoordinator;
  installations: InstallationRefreshService;
  isOwnerAlive: (owner: DiscoveryOwner) => Promise<boolean>;
}) {
  const ledger = createRepositoryDiscoveryLedger(input);
  const execute = createAccountRequest(input.coordinator);
  const operations = new Map<string, Operation>();
  const metadataCache = new Map<
    string,
    {
      accountId: string | null;
      revision: string | null;
      metadata: PullReviewerMetadata[];
      fetchedAt: number;
    }
  >();
  const resolvers = new Map<
    string,
    ReturnType<typeof createSelfHealingAccountResolver>
  >();
  const terminal = new Map<string, ReviewerFetchErrorEnvelope>();
  const owners = new Map<string, DiscoveryOwner>();
  const activeIds = new Map<string, string>();
  const rows = new Map<
    string,
    Set<{
      controller: AbortController;
      accountId: string | null;
      accessKey: string | undefined;
    }>
  >();
  let disposed = false;
  const key = (owner: DiscoveryOwner, id: string) =>
    JSON.stringify([owner.lane, owner.documentId, id]);

  function resolver(owner: DiscoveryOwner) {
    const id = JSON.stringify([owner.lane, owner.documentId]);
    owners.set(id, owner);
    let value = resolvers.get(id);
    if (!value) {
      value = createSelfHealingAccountResolver({
        requestRefresh: async (accountId) =>
          (await input.installations.refreshAccountInstallations(accountId)).ok,
      });
      resolvers.set(id, value);
    }
    return value;
  }
  function unavailable(
    reason: "interrupted" | "retired" | "unavailable",
  ): ReviewerFetchErrorEnvelope {
    return { kind: "unknown", status: null, discoveryOutcome: reason };
  }
  async function accountSummary(
    id: string | null,
  ): Promise<AccountSummary | null> {
    const account =
      id === null ? null : await accountMutations.getAccountById(id);
    return account ? summarizeAccount(account) : null;
  }
  async function fail(record: DiscoveryRecord): Promise<never> {
    throw new ReviewerFetchRuntimeError(
      record.error ??
        unavailable(record.status === "retired" ? "retired" : "interrupted"),
      await accountSummary(record.accountId),
    );
  }
  function check(operation: Operation) {
    throwIfReviewerAborted(operation.controller.signal);
    if (disposed) throw abortError();
  }
  function candidates(accounts: Account[], record: DiscoveryRecord) {
    return orderRepositoryCandidates({
      owner: record.repositoryOwner,
      repo: record.repo,
      attemptedAccountIds: record.attempts.map((attempt) => attempt.accountId),
      accounts: accounts.map((account) => ({
        accountId: account.id,
        active: !account.invalidated,
        present: true,
        installations: account.installations.map((installation) =>
          installation.repositorySelection === "all"
            ? { owner: installation.account.login, selection: "all" as const }
            : {
                owner: installation.account.login,
                selection: "selected" as const,
                repositoryFullNames: installation.repoSnapshot.fullNames,
                truncated:
                  installation.repoSnapshot.completeness === "truncated",
              },
        ),
      })),
    });
  }

  async function discover(
    owner: DiscoveryOwner,
    discovery: RepositoryDiscovery,
    operation: Operation,
    wantMetadata: boolean,
    targets?: string[],
    anonymousFailure?: unknown,
    refresh = false,
  ): Promise<Access> {
    const operationKey = key(owner, discovery.id);
    let record = await ledger.read(owner, discovery.id);
    const ownerKey = JSON.stringify([owner.lane, owner.documentId]);
    owners.set(ownerKey, owner);
    if (!activeIds.has(ownerKey)) activeIds.set(ownerKey, discovery.id);
    if (
      record.repositoryOwner !== discovery.owner.toLowerCase() ||
      record.repo !== discovery.repo.toLowerCase() ||
      record.generation !== discovery.generation
    )
      throw new DiscoveryUnavailableError("retired");
    const terminalError = terminal.get(operationKey);
    if (terminalError) return fail({ ...record, error: terminalError });
    check(operation);
    if (
      ["stopped", "exhausted", "interrupted", "retired"].includes(record.status)
    )
      return fail(record);

    let nextAccount: Account | null | undefined;
    let ordinaryMetadata = false;
    if (
      record.status === "success" &&
      record.accountId === null &&
      anonymousFailure !== undefined
    ) {
      nextAccount = await resolver(owner).resolveFallbackAccount(
        record.repositoryOwner,
      );
      check(operation);
      if (nextAccount === null)
        throw new ReviewerFetchRuntimeError(
          serializeReviewerFetchError(anonymousFailure),
          null,
        );
    } else if (record.status === "success") {
      const current =
        record.accountId === null
          ? null
          : await accountMutations.getAccountById(record.accountId);
      check(operation);
      const successful = record.attempts.find(
        (attempt) => attempt.accountId === record.accountId,
      );
      if (
        current?.invalidated &&
        record.authenticationFailure?.accountId === current.id &&
        record.authenticationFailure.revision === credentialGeneration(current)
      ) {
        record = await ledger.update(owner, discovery.id, (entry) => {
          check(operation);
          entry.status = "stopped";
          entry.error = entry.authenticationFailure!.error;
        });
        return fail(record);
      }
      if (
        record.accountId !== null &&
        (!current ||
          current.invalidated ||
          !successful ||
          successful.accessRevision !== (await accountAccessRevision(current)))
      ) {
        throw new DiscoveryUnavailableError("retired");
      }
      const cached = metadataCache.get(operationKey);
      const revision = current ? credentialGeneration(current) : null;
      const reusable =
        cached?.accountId === record.accountId && cached.revision === revision;
      if (
        !wantMetadata ||
        (!refresh &&
          reusable &&
          Date.now() - cached.fetchedAt <= METADATA_FRESH_MS &&
          (targets ?? []).every((target) =>
            cached.metadata.some((pull) => pull.number === target),
          ))
      ) {
        return {
          account: current ? summarizeAccount(current) : null,
          metadata: reusable ? cached.metadata : undefined,
          accessKey: current ? accountAccessKey(current) : undefined,
        };
      }
      nextAccount = current;
      ordinaryMetadata = true;
    } else if (record.status === "new") {
      nextAccount = await resolver(owner).resolveAccount(
        record.repositoryOwner,
        record.repo,
      );
      check(operation);
      if (nextAccount === null && owner.lane === "diagnostic") {
        // A matched diagnostic does not guess from an anonymous failure.
        return { account: null, metadata: undefined };
      }
    }

    while (true) {
      check(operation);
      if (nextAccount === undefined) {
        const accounts = await accountMutations.listAccounts();
        const candidate = candidates(accounts, record)[0];
        check(operation);
        if (!candidate) {
          record = await ledger.update(owner, discovery.id, (entry) => {
            check(operation);
            entry.status = "exhausted";
            if (entry.error) entry.error.discoveryOutcome = "exhausted";
          });
          return fail(record);
        }
        // Recheck the current registry/eligibility immediately before admission.
        const latest = await accountMutations.getAccountById(
          candidate.accountId,
        );
        check(operation);
        if (!latest || candidates([latest], record).length === 0) continue;
        nextAccount = latest;
      }
      const candidate = nextAccount;
      nextAccount = undefined;
      const id = candidate?.id ?? null;
      operation.accountId = id;
      operation.account = candidate ? summarizeAccount(candidate) : null;
      if (candidate)
        operation.accounts.set(candidate.id, accountAccessKey(candidate));
      if (!ordinaryMetadata && candidate) {
        const revision = credentialGeneration(candidate);
        const accessRevision = await accountAccessRevision(candidate);
        check(operation);
        record = await ledger.update(owner, discovery.id, (entry) => {
          check(operation);
          if (
            entry.attempts.some((attempt) => attempt.accountId === candidate.id)
          )
            throw new DiscoveryUnavailableError("interrupted");
          entry.attempts.push({
            accountId: candidate.id,
            revision,
            accessRevision,
            status: "admitted",
          });
          entry.accountId = candidate.id;
          entry.status = "running";
        });
      } else {
        record = await ledger.update(owner, discovery.id, (entry) => {
          check(operation);
          entry.status = "running";
        });
      }
      check(operation);
      try {
        const result = await execute({
          accountId: id,
          signal: operation.controller.signal,
          expectedAccessKey: candidate
            ? accountAccessKey(candidate)
            : undefined,
          onFailure: (error) => {
            operation.lastFailure =
              error === undefined
                ? undefined
                : serializeReviewerFetchError(error);
          },
          execute: (token, signal) =>
            fetchPullReviewerMetadataBatch({
              owner: record.repositoryOwner,
              repo: record.repo,
              githubToken: token,
              signal,
              ...(targets ? { targetPullNumbers: targets } : {}),
            }),
        });
        check(operation);
        const used = result.account;
        const revision = used ? credentialGeneration(used) : null;
        const accessRevision = used ? await accountAccessRevision(used) : null;
        check(operation);
        record = await ledger.update(owner, discovery.id, (entry) => {
          check(operation);
          entry.status = "success";
          entry.accountId = used?.id ?? null;
          delete entry.error;
          delete entry.authenticationFailure;
          const attempt = entry.attempts.find(
            (attempt) => attempt.accountId === used?.id,
          );
          if (attempt && revision && accessRevision) {
            attempt.status = "success";
            attempt.revision = revision;
            attempt.accessRevision = accessRevision;
          }
        });
        check(operation);
        if (used) {
          const latest = await accountMutations.getAccountById(used.id);
          if (!latest || accountAccessKey(latest) !== accountAccessKey(used))
            throw new DiscoveryUnavailableError("retired");
          check(operation);
        }
        metadataCache.set(operationKey, {
          accountId: used?.id ?? null,
          revision,
          metadata: result.value,
          fetchedAt: Date.now(),
        });
        return {
          account: used ? summarizeAccount(used) : null,
          metadata: result.value,
          accessKey: used ? accountAccessKey(used) : undefined,
          fresh: true,
        };
      } catch (error) {
        check(operation);
        const envelope = serializeReviewerFetchError(error);
        metadataCache.delete(operationKey);
        if (id === null) {
          const fallbackAllowed = envelope.failures?.some(
            (failure) =>
              failure.rateLimited ||
              [401, 403, 404, 429].includes(failure.status ?? 0),
          );
          const fallback = fallbackAllowed
            ? await resolver(owner).resolveFallbackAccount(
                record.repositoryOwner,
              )
            : null;
          check(operation);
          if (
            fallback &&
            !record.attempts.some(
              (attempt) => attempt.accountId === fallback.id,
            )
          ) {
            nextAccount = fallback;
            ordinaryMetadata = false;
            continue;
          }
        }
        const decision = classifyAuthenticatedFailure(error);
        const denied = id !== null && decision.kind === "repository-denial";
        record = await ledger.update(owner, discovery.id, (entry) => {
          check(operation);
          entry.status = denied ? "denied" : "stopped";
          entry.accountId = id;
          entry.error = envelope;
          const attempt = entry.attempts.find(
            (attempt) => attempt.accountId === id,
          );
          if (attempt) attempt.status = denied ? "denied" : "stopped";
        });
        check(operation);
        if (!denied) return fail(record);
        ordinaryMetadata = false;
      }
    }
  }

  function access(
    owner: DiscoveryOwner,
    discovery: RepositoryDiscovery,
    signal: AbortSignal,
    wantMetadata: boolean,
    targets?: string[],
    anonymousFailure?: unknown,
    refresh = false,
  ): Promise<Access> {
    if (signal.aborted) return Promise.reject(reviewerAbortReason(signal));
    const operationKey = key(owner, discovery.id);
    let operation = operations.get(operationKey);
    if (!operation) {
      const deadline = createReviewerDeadline(REVIEWER_DEADLINES.metadata);
      const created: Operation = {
        controller: deadline.controller,
        subscribers: new Set(),
        accounts: new Map(),
        accountId: null,
        account: null,
        promise: Promise.resolve({ account: null, metadata: undefined }),
      };
      operations.set(operationKey, created);
      created.promise = deadline
        .wait(
          Promise.resolve().then(() =>
            discover(
              owner,
              discovery,
              created,
              wantMetadata,
              targets,
              anonymousFailure,
              refresh,
            ),
          ),
        )
        .catch((error: unknown) => {
          if (
            error instanceof ReviewerFetchRuntimeError &&
            !created.controller.signal.aborted
          )
            throw error;
          const timedOut = error instanceof ReviewerTimeoutError;
          const reason = timedOut
            ? "unavailable"
            : error instanceof DiscoveryUnavailableError
              ? error.reason
              : created.controller.signal.aborted || disposed
                ? "interrupted"
                : "unavailable";
          const envelope: ReviewerFetchErrorEnvelope = {
            ...(timedOut
              ? serializeReviewerFetchError(error)
              : (created.lastFailure ?? unavailable(reason))),
            discoveryOutcome: reason,
          };
          if (
            disposed ||
            activeIds.get(JSON.stringify([owner.lane, owner.documentId])) !==
              discovery.id
          )
            throw new ReviewerFetchRuntimeError(envelope, created.account);
          terminal.set(operationKey, envelope);
          metadataCache.delete(operationKey);
          if (timedOut) {
            void ledger
              .update(owner, discovery.id, (record) => {
                record.status = "stopped";
                record.error = envelope;
                const attempt = record.attempts.find(
                  (value) => value.accountId === created.accountId,
                );
                if (attempt) attempt.status = "stopped";
              })
              .catch(() => undefined);
            throw new ReviewerFetchRuntimeError(envelope, created.account);
          }
          if (!disposed)
            void ledger
              .update(owner, discovery.id, (record) => {
                record.status =
                  reason === "retired" ? "retired" : "interrupted";
                record.error = envelope;
              })
              .catch(() => undefined);
          throw new ReviewerFetchRuntimeError(envelope, created.account);
        })
        .finally(() => {
          deadline.dispose();
          if (operations.get(operationKey) === created)
            operations.delete(operationKey);
        });
      operation = created;
    }
    const active = operation;
    const subscriber = {};
    active.subscribers.add(subscriber);
    return new Promise<Access>((resolve, reject) => {
      let detached = false;
      const detach = () => {
        if (detached) return;
        detached = true;
        signal.removeEventListener("abort", cancel);
        active.subscribers.delete(subscriber);
      };
      const cancel = () => {
        detach();
        reject(reviewerAbortReason(signal));
        if (active.subscribers.size === 0) active.controller.abort();
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      active.promise.then(
        (value) => {
          detach();
          if (!signal.aborted) resolve(value);
        },
        (error) => {
          detach();
          if (!signal.aborted) reject(error);
        },
      );
    });
  }

  async function rememberAuthenticationFailure(
    owner: DiscoveryOwner,
    discovery: RepositoryDiscovery,
    error: unknown,
    used: Account | null,
  ) {
    if (!used || error === undefined) return;
    const decision = classifyAuthenticatedFailure(error);
    if (decision.kind !== "stop" || decision.reason !== "authentication")
      return;
    // Persist the known 401 before the coordinator can invalidate this
    // generation. Its UI notification must retain authentication
    // guidance, including after worker recreation.
    await ledger.update(owner, discovery.id, async (entry) => {
      const current = await accountMutations.getAccountById(used.id);
      if (
        entry.status === "success" &&
        entry.accountId === used.id &&
        current &&
        credentialGeneration(current) === credentialGeneration(used)
      )
        entry.authenticationFailure = {
          accountId: used.id,
          revision: credentialGeneration(used),
          error: serializeReviewerFetchError(error),
        };
    });
  }

  return {
    ledger,
    initialize: () => ledger.initialize(),
    async begin(
      owner: DiscoveryOwner,
      request: {
        pageSession: string;
        generation: number;
        owner: string;
        repo: string;
      },
    ) {
      owners.set(JSON.stringify([owner.lane, owner.documentId]), owner);
      const discovery = await ledger.begin(owner, request);
      activeIds.set(
        JSON.stringify([owner.lane, owner.documentId]),
        discovery.id,
      );
      for (const [operationKey, operation] of operations) {
        const [lane, documentId, id] = JSON.parse(operationKey) as string[];
        if (
          lane === owner.lane &&
          documentId === owner.documentId &&
          id !== discovery.id
        )
          operation.controller.abort();
      }
      for (const [operationKey, pending] of rows) {
        const [lane, documentId, id] = JSON.parse(operationKey) as string[];
        if (
          lane === owner.lane &&
          documentId === owner.documentId &&
          id !== discovery.id
        )
          for (const row of pending) row.controller.abort();
      }
      for (const collection of [metadataCache, terminal])
        for (const operationKey of collection.keys()) {
          const [lane, documentId, id] = JSON.parse(operationKey) as string[];
          if (
            lane === owner.lane &&
            documentId === owner.documentId &&
            id !== discovery.id
          )
            collection.delete(operationKey);
        }
      return discovery;
    },
    async reference(
      owner: DiscoveryOwner,
      id: string,
    ): Promise<RepositoryDiscovery> {
      const record = await ledger.read(owner, id);
      return {
        id,
        owner: record.repositoryOwner,
        repo: record.repo,
        generation: record.generation,
      };
    },
    resolveAccount: (
      owner: DiscoveryOwner,
      repositoryOwner: string,
      repo: string,
    ) => resolver(owner).resolveAccount(repositoryOwner, repo),
    resolveFallbackAccount: (owner: DiscoveryOwner, repositoryOwner: string) =>
      resolver(owner).resolveFallbackAccount(repositoryOwner),
    async metadata(
      owner: DiscoveryOwner,
      discovery: RepositoryDiscovery,
      signal: AbortSignal,
      targets?: string[],
      refresh = false,
    ) {
      const resolved = await access(
        owner,
        discovery,
        signal,
        true,
        targets,
        undefined,
        refresh,
      );
      // A metadata caller may have joined a settled-success row lookup after
      // worker restoration. Fetch ordinary metadata without reopening discovery.
      if (
        (resolved.metadata === undefined || (refresh && !resolved.fresh)) &&
        (await ledger.read(owner, discovery.id)).status === "success"
      )
        return access(
          owner,
          discovery,
          signal,
          true,
          targets,
          undefined,
          refresh,
        );
      return resolved;
    },
    async summary(
      owner: DiscoveryOwner,
      discovery: RepositoryDiscovery,
      request: {
        pullNumber: string;
        signal: AbortSignal;
        pullMetadata?: PullReviewerMetadata;
        metadataAccount?: Pick<AccountSummary, "id" | "revision"> | null;
        validatePull?: boolean;
      },
    ) {
      return withReviewerDeadline(
        REVIEWER_DEADLINES.summary,
        request.signal,
        async (signal) => {
          request = { ...request, signal };
          const resolved = await access(
            owner,
            discovery,
            request.signal,
            false,
          );
          const cached = resolved.metadata?.find(
            (pull) => pull.number === request.pullNumber,
          );
          const supplied =
            request.metadataAccount?.id === resolved.account?.id &&
            request.metadataAccount?.revision === resolved.account?.revision
              ? request.pullMetadata
              : undefined;
          const pullMetadata = request.validatePull
            ? undefined
            : (cached ?? supplied);
          const controller = new AbortController();
          const cancel = () =>
            controller.abort(reviewerAbortReason(request.signal));
          request.signal.addEventListener("abort", cancel, { once: true });
          if (request.signal.aborted) cancel();
          const operationKey = key(owner, discovery.id);
          const row = {
            controller,
            accountId: resolved.account?.id ?? null,
            accessKey: resolved.accessKey,
          };
          const pending = rows.get(operationKey) ?? new Set();
          rows.set(operationKey, pending);
          pending.add(row);
          try {
            return await waitWithSignal(
              (async () => {
                try {
                  await ledger.read(owner, discovery.id);
                  const result = await execute({
                    accountId: resolved.account?.id ?? null,
                    signal: controller.signal,
                    expectedAccessKey: resolved.accessKey,
                    onFailure: (error, used) =>
                      rememberAuthenticationFailure(
                        owner,
                        discovery,
                        error,
                        used,
                      ),
                    execute: (token, signal) =>
                      fetchPullReviewerSummary({
                        owner: discovery.owner,
                        repo: discovery.repo,
                        pullNumber: request.pullNumber,
                        githubToken: token,
                        signal,
                        ...(pullMetadata ? { pullMetadata } : {}),
                      }),
                  });
                  await ledger.read(owner, discovery.id);
                  throwIfReviewerAborted(controller.signal);
                  return {
                    summary: result.value,
                    account: result.account
                      ? summarizeAccount(result.account)
                      : null,
                  };
                } catch (error) {
                  if (
                    resolved.account === null &&
                    !controller.signal.aborted &&
                    serializeReviewerFetchError(error).failures?.some(
                      (failure) =>
                        failure.rateLimited ||
                        [401, 403, 404, 429].includes(failure.status ?? 0),
                    )
                  ) {
                    const fallback = await access(
                      owner,
                      discovery,
                      controller.signal,
                      false,
                      undefined,
                      error,
                    );
                    if (fallback.account) {
                      row.accountId = fallback.account.id;
                      row.accessKey = fallback.accessKey;
                      const fallbackMetadata = fallback.metadata?.find(
                        (pull) => pull.number === request.pullNumber,
                      );
                      try {
                        const result = await execute({
                          accountId: fallback.account.id,
                          signal: controller.signal,
                          expectedAccessKey: fallback.accessKey,
                          onFailure: (error, used) =>
                            rememberAuthenticationFailure(
                              owner,
                              discovery,
                              error,
                              used,
                            ),
                          execute: (token, signal) =>
                            fetchPullReviewerSummary({
                              owner: discovery.owner,
                              repo: discovery.repo,
                              pullNumber: request.pullNumber,
                              githubToken: token,
                              signal,
                              ...(fallbackMetadata
                                ? { pullMetadata: fallbackMetadata }
                                : {}),
                            }),
                        });
                        await ledger.read(owner, discovery.id);
                        throwIfReviewerAborted(controller.signal);
                        return {
                          summary: result.value,
                          account: result.account
                            ? summarizeAccount(result.account)
                            : null,
                        };
                      } catch (fallbackError) {
                        throw new ReviewerFetchRuntimeError(
                          serializeReviewerFetchError(fallbackError),
                          fallback.account,
                        );
                      }
                    }
                  }
                  // Repository access is already established. A missing PR stays row-local.
                  throw new ReviewerFetchRuntimeError(
                    serializeReviewerFetchError(error),
                    resolved.account,
                  );
                }
              })(),
              controller.signal,
            );
          } finally {
            request.signal.removeEventListener("abort", cancel);
            pending.delete(row);
            if (pending.size === 0) rows.delete(operationKey);
          }
        },
      ).catch((error: unknown) => {
        if (error instanceof ReviewerFetchRuntimeError) throw error;
        throw new ReviewerFetchRuntimeError(serializeReviewerFetchError(error));
      });
    },
    accountsChanged(accounts: Account[]) {
      const current = new Map(
        accounts.map((account) => [account.id, accountAccessKey(account)]),
      );
      for (const operation of operations.values())
        for (const [id, previous] of operation.accounts) {
          if (current.get(id) !== previous) operation.controller.abort();
        }
      for (const pending of rows.values())
        for (const row of pending)
          if (
            row.accountId !== null &&
            current.get(row.accountId) !== row.accessKey
          )
            row.controller.abort();
    },
    async retire(owner: DiscoveryOwner, id: string) {
      const ownerKey = JSON.stringify([owner.lane, owner.documentId]);
      if (activeIds.get(ownerKey) === id) activeIds.delete(ownerKey);
      operations.get(key(owner, id))?.controller.abort();
      for (const row of rows.get(key(owner, id)) ?? []) row.controller.abort();
      metadataCache.delete(key(owner, id));
      terminal.delete(key(owner, id));
      await ledger.retire(owner, id);
    },
    async prune() {
      for (const [ownerKey, owner] of owners) {
        if (await input.isOwnerAlive(owner)) continue;
        for (const [operationKey, operation] of operations) {
          const [lane, documentId] = JSON.parse(operationKey) as string[];
          if (lane === owner.lane && documentId === owner.documentId)
            operation.controller.abort();
        }
        for (const [operationKey, pending] of rows) {
          const [lane, documentId] = JSON.parse(operationKey) as string[];
          if (lane === owner.lane && documentId === owner.documentId)
            for (const row of pending) row.controller.abort();
        }
        for (const collection of [metadataCache, terminal])
          for (const operationKey of collection.keys()) {
            const [lane, documentId] = JSON.parse(operationKey) as string[];
            if (lane === owner.lane && documentId === owner.documentId)
              collection.delete(operationKey);
          }
        owners.delete(ownerKey);
        activeIds.delete(ownerKey);
        resolvers.delete(ownerKey);
      }
      await ledger.prune();
    },
    dispose() {
      disposed = true;
      for (const operation of operations.values()) operation.controller.abort();
      for (const pending of rows.values())
        for (const row of pending) row.controller.abort();
      operations.clear();
      rows.clear();
      metadataCache.clear();
      terminal.clear();
      resolvers.clear();
      owners.clear();
      activeIds.clear();
      ledger.dispose();
    },
  };
}
export type RepositoryAccountService = ReturnType<
  typeof createRepositoryAccountService
>;
