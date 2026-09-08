import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { accountMutations } from "../src/storage/accounts";
import { REPOSITORY_DISCOVERY_KEY } from "../src/background/repository-discovery-ledger";
import {
  repositoryDiscoverySchema,
  type RepositoryDiscovery,
} from "../src/runtime/repository-discovery";
import { connectInput, deferred, json } from "./helpers/auth-harness";
import {
  contentSender,
  createUIBridgeHarness,
  containsSecret,
  drain,
} from "./helpers/ui-bridge-harness";

let harness: ReturnType<typeof createUIBridgeHarness>;
beforeEach(async () => {
  harness = createUIBridgeHarness({}, true);
  await harness.initialize();
  for (const id of ["A", "B"])
    await accountMutations.upsertAccountByLogin(
      connectInput({
        newAccountId: id,
        login: id,
        token: `fake-${id}`,
        refreshToken: `fake-refresh-${id}`,
        installations: [
          {
            id: 1,
            account: { login: "octo", type: "Organization", avatarUrl: null },
            repositorySelection: "all",
            repoSnapshot: null,
          },
        ],
        now: id === "A" ? 1 : 2,
      }),
    );
});
afterEach(async () => {
  harness.dispose();
  await drain();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function begin(documentId = "content-1", generation = 1) {
  const reply = (await harness.send(
    {
      type: "beginRepositoryDiscovery",
      pageSession: "page",
      generation,
      owner: "octo",
      repo: "repo",
    },
    contentSender(documentId),
  )) as { ok: boolean; data: unknown };
  expect(reply.ok).toBe(true);
  return repositoryDiscoverySchema.parse(reply.data);
}
function metadata(
  discovery: RepositoryDiscovery,
  documentId = "content-1",
  requestId = "request",
) {
  return harness.send(
    {
      type: "fetchPullReviewerMetadataBatch",
      requestId,
      owner: "octo",
      repo: "repo",
      accountId: "A",
      discoveryId: discovery.id,
      targetPullNumbers: ["42"],
    },
    contentSender(documentId),
  );
}
function ledger() {
  return harness.session.snapshot()[REPOSITORY_DISCOVERY_KEY] as {
    sessions: Record<string, { id: string }>;
    records: Record<string, { attempts: unknown[]; status: string }>;
  };
}

it("keeps a live content document's terminal budget across worker restart when Chrome getContexts omits it", async () => {
  harness.browserMock.runtime.getContexts.mockImplementation(
    async ({ documentIds }) =>
      documentIds
        .filter((id) => id.startsWith("options") && harness.alive.has(id))
        .map((documentId) => ({ documentId })),
  );
  const fetcher = vi.fn(async () => json({}, 429));
  vi.stubGlobal("fetch", fetcher);
  const discovery = await begin();
  expect(await metadata(discovery)).toMatchObject({
    ok: false,
    error: { status: 429 },
  });
  await harness.restart();
  expect(await begin()).toEqual(discovery);
  expect(await metadata(discovery)).toMatchObject({
    ok: false,
    error: { status: 429 },
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(ledger().records[discovery.id]?.attempts).toHaveLength(1);
  expect(containsSecret(ledger())).toBe(false);
  expect(harness.browserMock.tabs.sendMessage).toHaveBeenCalledWith(
    2,
    { type: "repositoryDiscoveryDocumentProbe" },
    { documentId: "content-1" },
  );
});

it.each(["replaced", "closed"])(
  "aborts a %s content document's live probe and removes its session ledger",
  async (event) => {
    const held = deferred<Response>();
    const entered = deferred<void>();
    let signal: AbortSignal | null | undefined;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      signal = init?.signal;
      entered.resolve();
      return held.promise;
    });
    vi.stubGlobal("fetch", fetcher);
    const discovery = await begin();
    const pending = metadata(discovery);
    await entered.promise;
    harness.alive.delete("content-1");
    if (event === "closed") {
      harness.browserMock.tabs.onRemoved.emit(2);
      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    } else await begin("content-2");
    expect(signal?.aborted).toBe(true);
    expect(await pending).toMatchObject({ ok: false });
    held.resolve(json({}, 404));
    await drain();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(ledger().records[discovery.id]).toBeUndefined();
    expect(
      Object.values(ledger().sessions).some(
        (entry) => entry.id === discovery.id,
      ),
    ).toBe(false);
  },
);

it("retains the budget on ordinary content port disconnect and frozen-tab checks", async () => {
  const client = harness.client(contentSender());
  const unsubscribe = client.subscribe(() => {});
  await client.read();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({}, 404)),
  );
  const discovery = await begin();
  await metadata(discovery);
  unsubscribe();
  client.dispose();
  await drain();
  harness.browserMock.tabs.get.mockResolvedValue({
    discarded: false,
    frozen: true,
  });
  harness.browserMock.tabs.sendMessage.mockClear();
  await harness.restart();
  expect(await begin()).toEqual(discovery);
  expect(ledger().records[discovery.id]?.attempts).toHaveLength(2);
  expect(harness.browserMock.tabs.sendMessage).not.toHaveBeenCalled();
});

it("rejects foreign document/repository discovery IDs without issuing HTTP", async () => {
  const discovery = await begin();
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect(await metadata(discovery, "content-2")).toMatchObject({ ok: false });
  expect(
    await harness.send(
      {
        type: "fetchPullReviewerMetadataBatch",
        requestId: "other",
        owner: "octo",
        repo: "other",
        accountId: "A",
        discoveryId: discovery.id,
        targetPullNumbers: ["42"],
      },
      contentSender("content-1", "octo/other"),
    ),
  ).toMatchObject({ ok: false });
  expect(fetcher).not.toHaveBeenCalled();
});

it("honors diagnostic cancel before dispatch and independently cancels an in-flight run", async () => {
  const held = deferred<Response>();
  const entered = deferred<void>();
  let signal: AbortSignal | null | undefined;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    signal = init?.signal;
    entered.resolve();
    return held.promise;
  });
  vi.stubGlobal("fetch", fetcher);
  await harness.send({ type: "cancelRepositoryDiagnostic", runId: "early" });
  expect(
    await harness.send({
      type: "diagnoseRepository",
      runId: "early",
      generation: 1,
      owner: "octo",
      repo: "repo",
      mode: "matched",
    }),
  ).toMatchObject({ ok: true, data: { kind: "failed" } });
  expect(fetcher).not.toHaveBeenCalled();
  const pending = harness.send({
    type: "diagnoseRepository",
    runId: "live",
    generation: 2,
    owner: "octo",
    repo: "repo",
    mode: "matched",
  });
  await entered.promise;
  await harness.send({ type: "cancelRepositoryDiagnostic", runId: "live" });
  expect(await pending).toMatchObject({ ok: true, data: { kind: "failed" } });
  expect(signal?.aborted).toBe(true);
  held.resolve(json({}, 404));
  await drain();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(containsSecret(harness.replies)).toBe(false);
});
