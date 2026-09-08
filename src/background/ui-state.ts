import { summarizeAccount } from "./account-summary";
import { accountAccessKey, accountDiscoveryKey } from "./account-request";
import { accountMutations, type Account } from "../storage/accounts";
import {
  getPreferences,
  isAccountsChange,
  isPreferencesChange,
} from "../storage/preferences";
import { uiSnapshotSchema, type UISnapshot } from "../runtime/ui-contract";

export type UIContextKind = "options" | "content";

/** Only background subscribes to raw storage. Every outgoing value is projected. */
export function createUIStateService(
  ensureReady: () => Promise<void>,
  onAccounts?: (accounts: Account[]) => void,
) {
  const epoch = crypto.randomUUID();
  const subscribers = new Set<{
    kind: UIContextKind;
    send: (snapshot: UISnapshot) => void;
  }>();
  let current: UISnapshot | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let disposed = false;

  function forContext(snapshot: UISnapshot, kind: UIContextKind): UISnapshot {
    return uiSnapshotSchema.parse({
      epoch: snapshot.epoch,
      revision: snapshot.revision,
      accountsRevision: snapshot.accountsRevision,
      discoveryRevision: snapshot.discoveryRevision,
      preferences: snapshot.preferences,
      accounts: kind === "options" ? snapshot.accounts : null,
    });
  }

  function refresh(): Promise<UISnapshot> {
    const operation = tail.then(async () => {
      if (disposed) throw new Error("ui_state_disposed");
      await ensureReady();
      if (disposed) throw new Error("ui_state_disposed");
      const [accounts, preferences] = await Promise.all([
        accountMutations.listAccounts(),
        getPreferences(),
      ]);
      // Internal token rotation updates options summaries but does not reopen
      // content discovery. Only an auth incarnation/coverage change does that.
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify(accounts.map(accountAccessKey)),
        ),
      );
      const accountsRevision = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const discoveryDigest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify(accounts.map(accountDiscoveryKey)),
        ),
      );
      const discoveryRevision = Array.from(
        new Uint8Array(discoveryDigest),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      if (disposed) throw new Error("ui_state_disposed");
      onAccounts?.(accounts);
      const summaries = accounts.map(summarizeAccount);
      if (
        current?.accountsRevision === accountsRevision &&
        JSON.stringify(current.accounts) === JSON.stringify(summaries) &&
        JSON.stringify(current.preferences) === JSON.stringify(preferences)
      )
        return current;
      current = uiSnapshotSchema.parse({
        epoch,
        revision: (current?.revision ?? -1) + 1,
        accountsRevision,
        discoveryRevision,
        preferences,
        accounts: summaries,
      });
      for (const subscriber of subscribers)
        subscriber.send(forContext(current, subscriber.kind));
      return current;
    });
    tail = operation.catch(() => undefined);
    return operation;
  }

  const onChanged: Parameters<
    typeof browser.storage.onChanged.addListener
  >[0] = (changes, area) => {
    if (
      area === "local" &&
      (isAccountsChange(changes) || isPreferencesChange(changes))
    ) {
      // Errors are reported by snapshot requests; never serialize storage errors.
      void refresh().catch(() => undefined);
    }
  };
  browser.storage.onChanged.addListener(onChanged);

  return {
    async read(kind: UIContextKind): Promise<UISnapshot> {
      return forContext(await refresh(), kind);
    },
    subscribe(
      kind: UIContextKind,
      send: (snapshot: UISnapshot) => void,
      failed: () => void,
    ) {
      const subscriber = { kind, send };
      subscribers.add(subscriber); // Register before the initial read.
      void refresh().then(
        (snapshot) => {
          if (subscribers.has(subscriber)) send(forContext(snapshot, kind));
        },
        () => {
          if (subscribers.has(subscriber)) failed();
        },
      );
      return () => {
        subscribers.delete(subscriber);
      };
    },
    dispose() {
      disposed = true;
      browser.storage.onChanged.removeListener(onChanged);
      subscribers.clear();
    },
  };
}
