import {
  parsePreferences,
  preferencePatchSchema,
  type Preferences,
  type PreferencePatch,
} from "../shared/preferences";
export {
  DEFAULT_PREFERENCES,
  parsePreferences,
  type Preferences,
} from "../shared/preferences";

const PREFERENCES_KEY = "preferences";
const SETTINGS_KEY = "settings";
const ACCOUNT_KEY_PREFIX = "account:";

export async function getPreferences(): Promise<Preferences> {
  const result = await browser.storage.local.get(PREFERENCES_KEY);
  return parsePreferences(result[PREFERENCES_KEY]);
}

let pendingUpdate: Promise<void> = Promise.resolve();

export function updatePreferences(
  patch: PreferencePatch,
): Promise<Preferences> {
  // Background-only owner: every options document shares this short queue.
  const validated = preferencePatchSchema.parse(patch);
  const update = pendingUpdate.then(async () => {
    const current = await getPreferences();
    const next: Preferences = {
      version: 1,
      language: validated.language ?? current.language,
      showStateBadge: validated.showStateBadge ?? current.showStateBadge,
      showReviewerName: validated.showReviewerName ?? current.showReviewerName,
      openPullsOnly: validated.openPullsOnly ?? current.openPullsOnly,
    };
    await browser.storage.local.set({ [PREFERENCES_KEY]: next });
    return next;
  });
  pendingUpdate = update.then(
    () => undefined,
    () => undefined,
  );
  return update;
}

type StorageChange = { oldValue?: unknown; newValue?: unknown };

export function isPreferencesChange(
  changes: Record<string, StorageChange>,
): boolean {
  return PREFERENCES_KEY in changes;
}

export function isAccountsChange(
  changes: Record<string, StorageChange>,
): boolean {
  return Object.entries(changes).some(([key, change]) => {
    if (key === SETTINGS_KEY) return true;
    if (!key.startsWith(ACCOUNT_KEY_PREFIX)) return false;
    // Revision metadata migration preserves the credential identity and must
    // not abort/restart active reviewer work. Actual rotations still refresh.
    return !(key.startsWith("account:auth:") && isGenerationMigration(change));
  });
}

function isGenerationMigration({ oldValue, newValue }: StorageChange): boolean {
  if (
    oldValue == null ||
    newValue == null ||
    typeof oldValue !== "object" ||
    typeof newValue !== "object" ||
    Array.isArray(oldValue) ||
    Array.isArray(newValue)
  )
    return false;
  const oldRecord = oldValue as Record<string, unknown>;
  const newRecord = newValue as Record<string, unknown>;
  if (
    oldRecord.credentialGeneration !== undefined ||
    newRecord.credentialGeneration !== "legacy"
  )
    return false;
  const oldKeys = Object.keys(oldRecord).filter(
    (key) => key !== "credentialGeneration",
  );
  const newKeys = Object.keys(newRecord).filter(
    (key) => key !== "credentialGeneration",
  );
  return (
    oldKeys.length === newKeys.length &&
    oldKeys.every(
      (key) =>
        Object.hasOwn(newRecord, key) && oldRecord[key] === newRecord[key],
    )
  );
}
