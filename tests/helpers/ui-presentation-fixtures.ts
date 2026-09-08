import {
  DEFAULT_PREFERENCES,
  parsePreferences,
  type Preferences,
} from "../../src/shared/preferences";
import { isAccountsChange } from "../../src/storage/preferences";
import type { UIChange } from "../../src/runtime/ui-client";
import type { UISnapshot } from "../../src/runtime/ui-contract";

/** Presentation-only fixture adapter. Security assertions use the real bridge
 * in ui-bridge/ui-preferences and packaged extension tests, never this adapter. */
export function createUIPresentationFixtures(
  readPreferences: () => Promise<Preferences>,
) {
  const listeners = new Set<(change: UIChange) => void>();
  let snapshot: UISnapshot = {
    epoch: "fixture",
    revision: 0,
    accountsRevision: "0",
    accounts: null,
    preferences: DEFAULT_PREFERENCES,
  };
  let ready: Promise<UISnapshot> | undefined;
  let resolveEvent: ((value: UISnapshot) => void) | undefined;
  const client = {
    read: () =>
      (ready ??= Promise.race([
        new Promise<UISnapshot>((resolve) => {
          resolveEvent = resolve;
        }),
        readPreferences().then((preferences) => {
          if (snapshot.revision === 0) snapshot = { ...snapshot, preferences };
          return snapshot;
        }),
      ])),
    subscribe(listener: (change: UIChange) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => listeners.clear(),
  };
  function publishFixtureChange(
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
    area: string,
  ) {
    if (area !== "local") return;
    const previous = snapshot;
    snapshot = {
      ...snapshot,
      revision: snapshot.revision + 1,
      preferences:
        "preferences" in changes
          ? parsePreferences(changes.preferences?.newValue)
          : snapshot.preferences,
      accountsRevision: isAccountsChange(changes)
        ? String(snapshot.revision + 1)
        : snapshot.accountsRevision,
    };
    resolveEvent?.(snapshot);
    for (const listener of listeners) listener({ snapshot, previous });
  }
  return { client, listeners, publishFixtureChange };
}
