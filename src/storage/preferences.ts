import { z } from "zod";

import { SUPPORTED_LOCALES } from "../i18n/locale";

const PREFERENCES_KEY = "preferences";
const SETTINGS_KEY = "settings";
const ACCOUNT_KEY_PREFIX = "account:";

const preferencesSchema = z.object({
  version: z.literal(1),
  language: z.enum(["auto", ...SUPPORTED_LOCALES]).catch("auto"),
  showStateBadge: z.boolean(),
  showReviewerName: z.boolean(),
  openPullsOnly: z.boolean().default(true),
});

export type Preferences = z.infer<typeof preferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = {
  version: 1,
  language: "auto",
  showStateBadge: true,
  showReviewerName: false,
  openPullsOnly: true,
};

export function parsePreferences(value: unknown): Preferences {
  const parsed = preferencesSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...DEFAULT_PREFERENCES };
}

export async function getPreferences(): Promise<Preferences> {
  const result = await browser.storage.local.get(PREFERENCES_KEY);
  return parsePreferences(result[PREFERENCES_KEY]);
}

let pendingUpdate: Promise<void> = Promise.resolve();

export function updatePreferences(
  patch: Partial<Omit<Preferences, "version">>,
): Promise<Preferences> {
  // Concurrent controls in one options context must merge against the latest write.
  const update = pendingUpdate.then(async () => {
    const current = await getPreferences();
    const next: Preferences = { ...current, ...patch, version: 1 };
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
