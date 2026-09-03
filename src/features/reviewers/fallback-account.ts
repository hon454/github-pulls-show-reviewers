import type { Account } from "../../storage/accounts";

export type FallbackAccountIntegration = {
  read(owner: string): Account | null | undefined;
  get(owner: string): Promise<Account | null>;
  clear(): void;
};

export function createFallbackAccountIntegration(
  resolveFallbackAccount: (owner: string) => Promise<Account | null>,
): FallbackAccountIntegration {
  let cache: { owner: string; account: Account | null } | null = null;
  let generation = 0;
  let request: { owner: string; promise: Promise<Account | null> } | null =
    null;

  function read(owner: string): Account | null | undefined {
    return cache?.owner === owner ? cache.account : undefined;
  }

  async function get(owner: string): Promise<Account | null> {
    const cached = read(owner);
    if (cached !== undefined) {
      return cached;
    }

    if (request?.owner === owner) {
      return request.promise;
    }

    const requestGeneration = generation;
    const nextRequest = {
      owner,
      promise: resolveFallbackAccount(owner).then((account) => {
        if (generation === requestGeneration) {
          cache = { owner, account };
        }
        return account;
      }),
    };
    request = nextRequest;
    try {
      return await nextRequest.promise;
    } finally {
      if (request === nextRequest) {
        request = null;
      }
    }
  }

  return {
    read,
    get,
    clear(): void {
      generation += 1;
      cache = null;
      request = null;
    },
  };
}
