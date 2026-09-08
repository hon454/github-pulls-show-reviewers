import { z } from "zod";
import type { RefreshCoordinator } from "../auth/refresh-coordinator";
import { getGitHubAppConfig } from "../config/github-app";
import { accountMutations } from "../storage/accounts";
import { updatePreferences } from "../storage/preferences";
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
import {
  DISCOVERY_DOCUMENT_PROBE,
  repositoryDiscoverySchema,
} from "../runtime/repository-discovery";
import { createRepositoryAccountService } from "./repository-accounts";
import type { DiscoveryOwner } from "./repository-discovery-ledger";

export function createUIBridge(input: {
  ensureReady: () => Promise<void>;
  coordinator: RefreshCoordinator;
  installations: InstallationRefreshService;
  reviewers: ReviewerFetchService;
  isOwnerAlive?: (owner: string) => Promise<boolean>;
  isDiscoveryOwnerAlive?: (owner: DiscoveryOwner) => Promise<boolean>;
}) {
  type Port = ReturnType<typeof browser.runtime.connect>;
  const ports = new Map<string, Set<Port>>();
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
  const repositories = createRepositoryAccountService({
    ...input,
    isOwnerAlive:
      input.isDiscoveryOwnerAlive ??
      (async (owner) => {
        if (owner.lane === "diagnostic") return isOwnerAlive(owner.documentId);
        // Chrome getContexts omits live content documents. A disconnected port
        // or worker reconnection must therefore never reset their ledger.
        if (owner.tabId === undefined || !browser.tabs?.get) return true;
        try {
          const tab = await browser.tabs.get(owner.tabId);
          if (tab.discarded) return false;
          if (tab.frozen) return true;
          if (!browser.tabs.sendMessage) return true;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            // A suspended/unresponsive document is uncertain, not confirmed lost.
            // It must not block another tab's startup or lose its attempt budget.
            const reply: unknown = await Promise.race([
              browser.tabs.sendMessage(
                owner.tabId,
                { type: DISCOVERY_DOCUMENT_PROBE },
                { documentId: owner.documentId },
              ),
              new Promise((resolve) => {
                timer = setTimeout(() => resolve({ alive: true }), 1_000);
              }),
            ]);
            return z.object({ alive: z.literal(true) }).safeParse(reply)
              .success;
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        } catch {
          return false;
        }
      }),
  });
  const state = createUIStateService(
    input.ensureReady,
    repositories.accountsChanged,
  );
  const discoveryOwner = (context: UIContext): DiscoveryOwner => ({
    documentId: context.documentId,
    lane: context.kind === "content" ? "content" : "diagnostic",
    ...(context.tabId === undefined ? {} : { tabId: context.tabId }),
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
  const diagnose = createDiagnosticsService(input.coordinator, repositories);
  const diagnosticControllers = new Map<string, Set<AbortController>>();
  const canceledDiagnostics = new Map<string, number>();
  const onTabRemoved = () => {
    void repositories.prune().catch(() => undefined);
    for (const [requestKey, controllers] of diagnosticControllers)
      void isOwnerAlive(requestKey.split(":")[0])
        .then((alive) => {
          if (!alive) for (const controller of controllers) controller.abort();
        })
        .catch(() => undefined);
  };
  browser.tabs?.onRemoved?.addListener(onTabRemoved);

  function resolver(context: UIContext) {
    const owner = discoveryOwner(context);
    return {
      resolveAccount: (repositoryOwner: string, repo: string) =>
        repositories.resolveAccount(owner, repositoryOwner, repo),
      resolveFallbackAccount: (repositoryOwner: string) =>
        repositories.resolveFallbackAccount(owner, repositoryOwner),
    };
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
            "beginRepositoryDiscovery",
            "retireRepositoryDiscovery",
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
          case "beginRepositoryDiscovery":
            await repositories.prune();
            return success(
              repositoryDiscoverySchema,
              await repositories.begin(discoveryOwner(context), request),
            );
          case "retireRepositoryDiscovery":
            await repositories.retire(
              discoveryOwner(context),
              request.discoveryId,
            );
            return success(z.null(), null);
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
          case "diagnoseRepository": {
            const runId = request.runId ?? crypto.randomUUID();
            const requestKey = `${context.documentId}:${runId}`;
            const controller = new AbortController();
            for (const [id, canceledAt] of canceledDiagnostics)
              if (Date.now() - canceledAt > 60_000)
                canceledDiagnostics.delete(id);
            if (canceledDiagnostics.has(requestKey)) controller.abort();
            const controllers =
              diagnosticControllers.get(requestKey) ?? new Set();
            controllers.add(controller);
            diagnosticControllers.set(requestKey, controllers);
            try {
              return success(
                repositoryDiagnosticSchema,
                await diagnose(request.owner, request.repo, request.mode, {
                  owner: discoveryOwner(context),
                  runId,
                  generation: request.generation ?? Date.now(),
                  signal: controller.signal,
                }),
              );
            } finally {
              controllers.delete(controller);
              if (controllers.size === 0)
                diagnosticControllers.delete(requestKey);
            }
          }
          case "cancelRepositoryDiagnostic": {
            const key = `${context.documentId}:${request.runId}`;
            for (const [id, canceledAt] of canceledDiagnostics)
              if (Date.now() - canceledAt > 60_000)
                canceledDiagnostics.delete(id);
            canceledDiagnostics.set(key, Date.now());
            for (const controller of diagnosticControllers.get(key) ?? [])
              controller.abort();
            return success(z.null(), null);
          }
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
        if (!summary.data.discoveryId)
          return { ok: false, error: "unavailable" };
        const owner = discoveryOwner(context);
        const discovery = await repositories.reference(
          owner,
          summary.data.discoveryId,
        );
        if (
          discovery.owner !== summary.data.owner.toLowerCase() ||
          discovery.repo !== summary.data.repo.toLowerCase()
        )
          return forbidden();
        return fetchPullReviewerSummaryResponseSchema.parse(
          await input.reviewers.handleFetchMessage(
            {
              ...summary.data,
              requestId: `${context.documentId}:${summary.data.requestId}`,
            },
            { service: repositories, owner, discovery },
          ),
        );
      }
      const metadata =
        fetchPullReviewerMetadataBatchMessageSchema.safeParse(message);
      if (metadata.success && context.kind === "content") {
        if (!ownsRepository(context, metadata.data.owner, metadata.data.repo))
          return forbidden();
        if (!metadata.data.discoveryId)
          return { ok: false, error: "unavailable" };
        const owner = discoveryOwner(context);
        const discovery = await repositories.reference(
          owner,
          metadata.data.discoveryId,
        );
        if (
          discovery.owner !== metadata.data.owner.toLowerCase() ||
          discovery.repo !== metadata.data.repo.toLowerCase()
        )
          return forbidden();
        return fetchPullReviewerMetadataBatchResponseSchema.parse(
          await input.reviewers.handleMetadataBatchMessage(
            {
              ...metadata.data,
              requestId: `${context.documentId}:${metadata.data.requestId}`,
            },
            { service: repositories, owner, discovery },
          ),
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
        if (context.kind === "options") {
          void (async () => {
            if (
              typeof browser.runtime.getContexts === "function" &&
              !(await isOwnerAlive(context.documentId))
            ) {
              await flow.retireOwner(context.documentId);
              for (const [key, controllers] of diagnosticControllers)
                if (key.startsWith(`${context.documentId}:`))
                  for (const controller of controllers) controller.abort();
              await repositories.prune();
            }
          })().catch(() => undefined);
        }
      }
    };
    port.onDisconnect.addListener(disconnect);
  }
  return {
    handle,
    connect,
    initialize: async () => {
      await flow.initialize();
      await repositories.initialize();
    },
    dispose: () => {
      state.dispose();
      repositories.dispose();
      browser.tabs?.onRemoved?.removeListener(onTabRemoved);
      for (const controllers of diagnosticControllers.values())
        for (const controller of controllers) controller.abort();
      diagnosticControllers.clear();
      canceledDiagnostics.clear();
    },
  };
}
