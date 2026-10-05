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
const emptyStore = (): Store => ({ version: 1, sessions: {}, records: {} });

/**
 * One short persistence queue; HTTP, subscriber waits and document liveness
 * probes never hold it. Callers probe owners first and apply the result with
 * `forget`, so one unresponsive document cannot delay another's discovery.
 */
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
    const parsed =
      stored === undefined ? undefined : storeSchema.safeParse(stored);
    // A malformed record must not reject every later ledger operation,
    // including anonymous public rows. Start over and replace the bad value.
    let changed = parsed?.success === false;
    const state = parsed?.success ? parsed.data : emptyStore();
    for (const record of Object.values(state.records)) {
      // An unacknowledged dispatch cannot be replayed or called a denial.
      if (
        record.status !== "interrupted" &&
        (record.status === "running" ||
          record.attempts.some((attempt) => attempt.status === "admitted"))
      ) {
        record.status = "interrupted";
        changed = true;
      }
    }
    if (changed) {
      try {
        await browser.storage.session.set({
          [REPOSITORY_DISCOVERY_KEY]: state,
        });
      } catch {
        // Keep the repaired state in memory: reads still work, and the next
        // save replaces the stored value. Admission saves still fail closed.
      }
    }
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
    async begin(
      owner: DiscoveryOwner,
      request: {
        pageSession: string;
        generation: number;
        owner: string;
        repo: string;
      },
    ): Promise<RepositoryDiscovery> {
      // Probe before entering the queue: only this document waits for itself.
      if (!(await input.isOwnerAlive(owner)))
        throw new DiscoveryUnavailableError("retired");
      return queued(async (state) => {
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
    /** Session owners for a liveness probe that runs outside the queue. */
    owners(): Promise<Array<{ owner: DiscoveryOwner; id: string }>> {
      return queued(async (state) =>
        Object.values(state.sessions).map((header) => ({
          owner: structuredClone(header.owner),
          id: header.id,
        })),
      );
    },
    /**
     * Removes documents a probe found lost, in one short step that skips
     * no-op writes. `id` is the session the probe saw (null: none). A session
     * that changed since then is newer than the probe and is kept. Returns
     * the documents whose session is gone, so callers release only those.
     */
    forget(
      lost: Array<{ owner: DiscoveryOwner; id: string | null }>,
    ): Promise<DiscoveryOwner[]> {
      return queued(async (state) => {
        const gone: DiscoveryOwner[] = [];
        const removed: string[] = [];
        for (const { owner, id } of lost) {
          const header = state.sessions[ownerKey(owner)];
          if (!header) gone.push(owner);
          else if (header.id === id) {
            gone.push(owner);
            removed.push(ownerKey(owner));
          }
        }
        if (removed.length === 0) return gone;
        const next = structuredClone(state);
        for (const key of removed) {
          delete next.records[next.sessions[key].id];
          delete next.sessions[key];
        }
        await save(next);
        return gone;
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
