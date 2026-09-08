import { z } from "zod";
import { reviewerFetchErrorSchema } from "../runtime/reviewer-fetch";
import type { RepositoryDiscovery } from "../runtime/repository-discovery";

export const REPOSITORY_DISCOVERY_KEY = "repository-discovery:v1";
export type DiscoveryOwner = {
  documentId: string;
  lane: "content" | "diagnostic";
  tabId?: number | undefined;
};
const ownerSchema = z.object({
  documentId: z.string(),
  lane: z.enum(["content", "diagnostic"]),
  tabId: z.number().optional(),
});
const attemptSchema = z.object({
  accountId: z.string(),
  revision: z.string(),
  accessRevision: z.string(),
  status: z.enum(["admitted", "success", "denied", "stopped"]),
});
const recordSchema = z.object({
  id: z.string(),
  owner: ownerSchema,
  pageSession: z.string(),
  generation: z.number().int().nonnegative(),
  repositoryOwner: z.string(),
  repo: z.string(),
  status: z.enum([
    "new",
    "running",
    "denied",
    "success",
    "stopped",
    "exhausted",
    "interrupted",
    "retired",
  ]),
  attempts: z.array(attemptSchema),
  accountId: z.string().nullable(),
  error: reviewerFetchErrorSchema.optional(),
  authenticationFailure: z
    .object({
      accountId: z.string(),
      revision: z.string(),
      error: reviewerFetchErrorSchema,
    })
    .optional(),
});
export type DiscoveryRecord = z.infer<typeof recordSchema>;
const headerSchema = z.object({
  owner: ownerSchema,
  pageSession: z.string(),
  generation: z.number().int().nonnegative(),
  id: z.string(),
  repositoryOwner: z.string(),
  repo: z.string(),
  retired: z.boolean(),
});
const storeSchema = z.object({
  version: z.literal(1),
  sessions: z.record(z.string(), headerSchema),
  records: z.record(z.string(), recordSchema),
});
type Store = z.infer<typeof storeSchema>;

export class DiscoveryUnavailableError extends Error {
  constructor(
    public readonly reason: "interrupted" | "retired" | "unavailable",
  ) {
    super(`repository_discovery_${reason}`);
  }
}

const ownerKey = (owner: DiscoveryOwner) =>
  JSON.stringify([owner.lane, owner.documentId]);

/** One short persistence queue; HTTP and subscriber waits never hold it. */
export function createRepositoryDiscoveryLedger(input: {
  ensureReady: () => Promise<void>;
  isOwnerAlive: (owner: DiscoveryOwner) => Promise<boolean>;
}) {
  let current: Store | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let disposed = false;

  async function load(): Promise<Store> {
    if (disposed) throw new DiscoveryUnavailableError("retired");
    if (current) return current;
    await input.ensureReady();
    const stored = (
      await browser.storage.session.get(REPOSITORY_DISCOVERY_KEY)
    )[REPOSITORY_DISCOVERY_KEY];
    const state =
      stored === undefined
        ? { version: 1 as const, sessions: {}, records: {} }
        : storeSchema.parse(stored);
    let changed = false;
    for (const [key, header] of Object.entries(state.sessions)) {
      if (!(await input.isOwnerAlive(header.owner))) {
        delete state.sessions[key];
        delete state.records[header.id];
        changed = true;
      }
    }
    for (const record of Object.values(state.records)) {
      // An unacknowledged dispatch cannot be replayed or called a denial.
      if (
        record.status === "running" ||
        record.attempts.some((attempt) => attempt.status === "admitted")
      ) {
        record.status = "interrupted";
        changed = true;
      }
    }
    if (changed)
      await browser.storage.session.set({ [REPOSITORY_DISCOVERY_KEY]: state });
    if (disposed) throw new DiscoveryUnavailableError("retired");
    current = state;
    return state;
  }

  function queued<T>(operation: (state: Store) => Promise<T>): Promise<T> {
    const work = tail.then(async () => operation(await load()));
    tail = work.catch(() => undefined);
    return work;
  }

  async function save(next: Store) {
    if (disposed) throw new DiscoveryUnavailableError("retired");
    await browser.storage.session.set({
      [REPOSITORY_DISCOVERY_KEY]: storeSchema.parse(next),
    });
    if (disposed) throw new DiscoveryUnavailableError("retired");
    current = next;
  }

  function recordFor(
    state: Store,
    owner: DiscoveryOwner,
    id: string,
  ): DiscoveryRecord {
    const header = state.sessions[ownerKey(owner)];
    const record = state.records[id];
    if (
      !header ||
      header.retired ||
      header.id !== id ||
      !record ||
      record.owner.documentId !== owner.documentId ||
      record.owner.lane !== owner.lane
    ) {
      throw new DiscoveryUnavailableError("retired");
    }
    return record;
  }

  return {
    initialize: () => queued(async () => {}),
    begin(
      owner: DiscoveryOwner,
      request: {
        pageSession: string;
        generation: number;
        owner: string;
        repo: string;
      },
    ): Promise<RepositoryDiscovery> {
      return queued(async (state) => {
        if (!(await input.isOwnerAlive(owner)))
          throw new DiscoveryUnavailableError("retired");
        const key = ownerKey(owner);
        const previous = state.sessions[key];
        const repositoryOwner = request.owner.toLowerCase();
        const repo = request.repo.toLowerCase();
        if (previous && request.generation <= previous.generation) {
          if (
            previous.retired ||
            request.generation !== previous.generation ||
            request.pageSession !== previous.pageSession ||
            repositoryOwner !== previous.repositoryOwner ||
            repo !== previous.repo
          ) {
            throw new DiscoveryUnavailableError("retired");
          }
          // A missing/evicted body is not a new generation. Return only its
          // original identity; read/admission fails closed for the absent body.
          return {
            id: previous.id,
            generation: previous.generation,
            owner: repositoryOwner,
            repo,
          };
        }
        const next = structuredClone(state);
        if (previous) delete next.records[previous.id];
        const id = crypto.randomUUID();
        next.sessions[key] = {
          owner,
          pageSession: request.pageSession,
          generation: request.generation,
          id,
          repositoryOwner,
          repo,
          retired: false,
        };
        next.records[id] = {
          id,
          owner,
          pageSession: request.pageSession,
          generation: request.generation,
          repositoryOwner,
          repo,
          status: "new",
          attempts: [],
          accountId: null,
        };
        await save(next);
        return {
          id,
          generation: request.generation,
          owner: repositoryOwner,
          repo,
        };
      });
    },
    read(owner: DiscoveryOwner, id: string): Promise<DiscoveryRecord> {
      return queued(async (state) =>
        structuredClone(recordFor(state, owner, id)),
      );
    },
    update(
      owner: DiscoveryOwner,
      id: string,
      change: (record: DiscoveryRecord) => void | Promise<void>,
    ): Promise<DiscoveryRecord> {
      return queued(async (state) => {
        recordFor(state, owner, id);
        const next = structuredClone(state);
        const record = recordFor(next, owner, id);
        await change(record);
        await save(next);
        return structuredClone(record);
      });
    },
    retire(owner: DiscoveryOwner, id: string): Promise<void> {
      return queued(async (state) => {
        const header = state.sessions[ownerKey(owner)];
        if (!header || header.id !== id) return;
        const next = structuredClone(state);
        next.sessions[ownerKey(owner)].retired = true;
        delete next.records[id];
        await save(next);
      });
    },
    prune(): Promise<void> {
      return queued(async (state) => {
        const next = structuredClone(state);
        for (const [key, header] of Object.entries(state.sessions)) {
          if (await input.isOwnerAlive(header.owner)) continue;
          delete next.sessions[key];
          delete next.records[header.id];
        }
        await save(next);
      });
    },
    dispose() {
      disposed = true;
    },
  };
}
export type RepositoryDiscoveryLedger = ReturnType<
  typeof createRepositoryDiscoveryLedger
>;
