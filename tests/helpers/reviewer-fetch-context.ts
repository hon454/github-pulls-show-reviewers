import { vi } from "vitest";
import type { RefreshCoordinator } from "../../src/auth/refresh-coordinator";
import { createInstallationRefreshService } from "../../src/background/installation-refresh";
import { createRepositoryAccountService } from "../../src/background/repository-accounts";
import type { DiscoveryOwner } from "../../src/background/repository-discovery-ledger";
import type { Installation } from "../../src/storage/accounts";
import { json } from "./auth-harness";

/** An installation that covers every repository of `owner`. */
export function coveringInstallation(owner: string): Installation {
  return {
    id: 1,
    account: { login: owner, type: "Organization", avatarUrl: null },
    repositorySelection: "all",
    repoSnapshot: null,
  };
}

/**
 * The only admission the UI bridge gives reviewer fetches: a content
 * document's repository discovery, owned by the production account service.
 * Needs `browser.storage.local` and `browser.storage.session`.
 */
export async function createReviewerFetchContext(input: {
  coordinator: RefreshCoordinator;
  repositoryOwner: string;
  repo: string;
  documentId?: string;
}) {
  const service = createRepositoryAccountService({
    ensureReady: async () => {},
    coordinator: input.coordinator,
    installations: createInstallationRefreshService({
      refreshCoordinator: input.coordinator,
    }),
    isOwnerAlive: async () => true,
  });
  const owner: DiscoveryOwner = {
    documentId: input.documentId ?? "content-1",
    lane: "content",
    tabId: 2,
  };
  const discovery = await service.begin(owner, {
    pageSession: "page",
    generation: 0,
    owner: input.repositoryOwner,
    repo: input.repo,
  });
  return { service, owner, discovery };
}

/**
 * Settle repository discovery with a pull list response from a separate
 * fetch stub, so the caller's HTTP fixture sees only the reviewer requests.
 */
export async function settleDiscovery(
  context: Awaited<ReturnType<typeof createReviewerFetchContext>>,
  pulls: unknown[] = [],
): Promise<void> {
  const previous = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(pulls)),
  );
  try {
    await context.service.metadata(
      context.owner,
      context.discovery,
      new AbortController().signal,
    );
  } finally {
    vi.stubGlobal("fetch", previous);
  }
}
