import { z } from "zod";
import type { RefreshCoordinator } from "../auth/refresh-coordinator";
import { getGitHubAppConfig } from "../config/github-app";
import { accountMutations } from "../storage/accounts";
import { updatePreferences } from "../storage/preferences";
import { createSelfHealingAccountResolver } from "./account-resolution";
import { summarizeAccount } from "./account-summary";
import { createDeviceFlowService, FlowOwnershipError } from "./device-flow";
import { createDiagnosticsService } from "./diagnostics";
import type { InstallationRefreshService } from "./installation-refresh";
import type { ReviewerFetchService } from "./reviewer-fetch";
import { createUIStateService } from "./ui-state";
import {
  identifyUIContext,
  ownsRepository,
  type UIContext,
  type UISender,
} from "./ui-sender";
import {
  accountSummarySchema,
  capabilityResponseSchema,
  deviceFlowProgressSchema,
  UI_STATE_PORT,
  uiRequestSchema,
  uiSnapshotSchema,
  uiStateEventSchema,
} from "../runtime/ui-contract";
import { repositoryDiagnosticSchema } from "../runtime/diagnostics";
import {
  fetchPullReviewerMetadataBatchMessageSchema,
  fetchPullReviewerMetadataBatchResponseSchema,
  fetchPullReviewerSummaryMessageSchema,
  fetchPullReviewerSummaryResponseSchema,
  cancelPullReviewerSummaryMessageSchema,
} from "../runtime/reviewer-fetch";
import { isOpenOptionsPageMessage } from "../runtime/options-page";
import { installationRefreshOutcomeSchema } from "../runtime/installation-refresh";

export function createUIBridge(input: {
  ensureReady: () => Promise<void>;
  coordinator: RefreshCoordinator;
  installations: InstallationRefreshService;
  reviewers: ReviewerFetchService;
  isOwnerAlive?: (owner: string) => Promise<boolean>;
}) {
  const state = createUIStateService(input.ensureReady);
  type Port = ReturnType<typeof browser.runtime.connect>;
  const ports = new Map<string, Set<Port>>();
  const resolvers = new Map<
    string,
    ReturnType<typeof createSelfHealingAccountResolver>
  >();
  const isOwnerAlive =
    input.isOwnerAlive ??
    (async (owner: string) => {
      // getContexts is an additional owner-loss check where Chrome supports it.
      // A disconnected port alone is not proof that its document disappeared.
      if (!browser.runtime.getContexts) return true;
      const contexts = await browser.runtime.getContexts({
        documentIds: [owner],
      });
      return contexts.some((context) => context.documentId === owner);
    });
  const flow = createDeviceFlowService({
    ensureReady: input.ensureReady,
    getClientId: () => getGitHubAppConfig().clientId,
    isOwnerAlive,
    onProgress(owner, attemptId, progress) {
      const event = uiStateEventSchema.parse({
        type: "deviceFlow",
        attemptId,
        progress,
      });
      for (const port of ports.get(owner) ?? []) {
        try {
          port.postMessage(event);
        } catch {
          /* A disconnected document receives nothing. */
        }
      }
    },
  });
  const diagnose = createDiagnosticsService(input.coordinator);

  function resolver(context: UIContext) {
    let service = resolvers.get(context.documentId);
    if (!service) {
      service = createSelfHealingAccountResolver({
        requestRefresh: async (accountId) =>
          (await input.installations.refreshAccountInstallations(accountId)).ok,
      });
      resolvers.set(context.documentId, service);
    }
    return service;
  }
  function success<T extends z.ZodType>(schema: T, data: unknown) {
    return capabilityResponseSchema(schema).parse({ ok: true, data });
  }
  const forbidden = () => ({ ok: false as const, error: "forbidden" as const });

  async function handle(
    message: unknown,
    sender: UISender | undefined,
  ): Promise<unknown> {
    const context = identifyUIContext(sender);
    if (!context) return forbidden();
    try {
      await input.ensureReady();
      const parsed = uiRequestSchema.safeParse(message);
      if (parsed.success) {
        const request = parsed.data;
        if (
          context.kind !== "options" &&
          ![
            "getUISnapshot",
            "resolveAccount",
            "resolveFallbackAccount",
            "refreshAccountInstallations",
          ].includes(request.type)
        )
          return forbidden();
        if (
          "owner" in request &&
          !ownsRepository(context, request.owner, request.repo)
        )
          return forbidden();
        switch (request.type) {
          case "getUISnapshot":
            return success(uiSnapshotSchema, await state.read(context.kind));
          case "patchPreferences":
            await updatePreferences(request.patch);
            return success(uiSnapshotSchema, await state.read("options"));
          case "resolveAccount": {
            const account = await resolver(context).resolveAccount(
              request.owner,
              request.repo,
            );
            return success(
              accountSummarySchema.nullable(),
              account ? summarizeAccount(account) : null,
            );
          }
          case "resolveFallbackAccount": {
            const account = await resolver(context).resolveFallbackAccount(
              request.owner,
            );
            return success(
              accountSummarySchema.nullable(),
              account ? summarizeAccount(account) : null,
            );
          }
          case "removeAccount":
            await accountMutations.removeAccount(request.accountId);
            return success(z.null(), null);
          case "refreshAccountInstallations": {
            if (context.kind === "content") {
              const repository = request.repository;
              if (
                !repository ||
                !ownsRepository(context, repository.owner, repository.repo)
              )
                return forbidden();
              const account = await accountMutations.getAccountById(
                request.accountId,
              );
              if (
                !account ||
                account.invalidated ||
                !account.installations.some(
                  (installation) =>
                    installation.account.login.toLowerCase() ===
                    repository.owner.toLowerCase(),
                )
              )
                return forbidden();
            }
            return success(
              installationRefreshOutcomeSchema,
              await input.installations.refreshAccountInstallations(
                request.accountId,
              ),
            );
          }
          case "diagnoseRepository":
            return success(
              repositoryDiagnosticSchema,
              await diagnose(request.owner, request.repo, request.mode),
            );
          case "startDeviceFlow":
            return success(
              deviceFlowProgressSchema,
              await flow.start(context.documentId, request.attemptId),
            );
          case "pollDeviceFlow":
            return success(
              deviceFlowProgressSchema,
              await flow.poll(
                context.documentId,
                request.attemptId,
                request.flowId,
              ),
            );
          case "cancelDeviceFlow":
            return success(
              deviceFlowProgressSchema,
              await flow.cancel(context.documentId, request.attemptId),
            );
        }
      }
      if (isOpenOptionsPageMessage(message)) {
        await browser.runtime.openOptionsPage();
        return { ok: true };
      }
      const cancel = cancelPullReviewerSummaryMessageSchema.safeParse(message);
      if (cancel.success && context.kind === "content") {
        input.reviewers.cancelRequest(
          `${context.documentId}:${cancel.data.requestId}`,
        );
        return undefined;
      }
      const summary = fetchPullReviewerSummaryMessageSchema.safeParse(message);
      if (summary.success && context.kind === "content") {
        if (!ownsRepository(context, summary.data.owner, summary.data.repo))
          return forbidden();
        return fetchPullReviewerSummaryResponseSchema.parse(
          await input.reviewers.handleFetchMessage({
            ...summary.data,
            requestId: `${context.documentId}:${summary.data.requestId}`,
          }),
        );
      }
      const metadata =
        fetchPullReviewerMetadataBatchMessageSchema.safeParse(message);
      if (metadata.success && context.kind === "content") {
        if (!ownsRepository(context, metadata.data.owner, metadata.data.repo))
          return forbidden();
        return fetchPullReviewerMetadataBatchResponseSchema.parse(
          await input.reviewers.handleMetadataBatchMessage({
            ...metadata.data,
            requestId: `${context.documentId}:${metadata.data.requestId}`,
          }),
        );
      }
      return { ok: false, error: "invalid-request" };
    } catch (error) {
      // Never return/log raw exceptions, schema issues, or OAuth HTTP bodies.
      return error instanceof FlowOwnershipError
        ? forbidden()
        : { ok: false, error: "unavailable" };
    }
  }

  function connect(port: Port) {
    if (port.name !== UI_STATE_PORT) return;
    const context = identifyUIContext(port.sender);
    if (!context) {
      port.disconnect();
      return;
    }
    let ownerPorts = ports.get(context.documentId);
    if (!ownerPorts) {
      ownerPorts = new Set();
      ports.set(context.documentId, ownerPorts);
    }
    ownerPorts.add(port);
    const send = (event: unknown) => {
      try {
        port.postMessage(uiStateEventSchema.parse(event));
      } catch {
        /* teardown owns cleanup */
      }
    };
    const unsubscribe = state.subscribe(
      context.kind,
      (snapshot) => send({ type: "snapshot", snapshot }),
      () => send({ type: "unavailable" }),
    );
    const disconnect = () => {
      unsubscribe();
      port.onDisconnect.removeListener(disconnect);
      ownerPorts.delete(port);
      if (ownerPorts.size === 0) {
        ports.delete(context.documentId);
        resolvers.delete(context.documentId);
        if (context.kind === "options") {
          void (async () => {
            if (
              typeof browser.runtime.getContexts === "function" &&
              !(await isOwnerAlive(context.documentId))
            )
              await flow.retireOwner(context.documentId);
          })().catch(() => undefined);
        }
      }
    };
    port.onDisconnect.addListener(disconnect);
  }
  return {
    handle,
    connect,
    initialize: () => flow.initialize(),
    dispose: () => state.dispose(),
  };
}
