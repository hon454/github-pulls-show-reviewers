import { z } from "zod";

const PREFERENCES_KEY = "preferences";
const SETTINGS_KEY = "settings";
const ACCOUNT_KEY_PREFIX = "account:";

const preferencesSchema = z.object({
  version: z.literal(1),
  showStateBadge: z.boolean(),
  showReviewerName: z.boolean(),
  openPullsOnly: z.boolean().default(true),
});

export type Preferences = z.infer<typeof preferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = {
  version: 1,
  showStateBadge: true,
  showReviewerName: false,
  openPullsOnly: true,
};

export async function getPreferences(): Promise<Preferences> {
  const result = await browser.storage.local.get(PREFERENCES_KEY);
  const parsed = preferencesSchema.safeParse(result[PREFERENCES_KEY]);
  return parsed.success ? parsed.data : DEFAULT_PREFERENCES;
}

export async function updatePreferences(
  patch: Partial<Omit<Preferences, "version">>,
): Promise<Preferences> {
  const current = await getPreferences();
  const next: Preferences = { ...current, ...patch, version: 1 };
  await browser.storage.local.set({ [PREFERENCES_KEY]: next });
  return next;
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
  return Object.keys(changes).some(
    (key) => key === SETTINGS_KEY || key.startsWith(ACCOUNT_KEY_PREFIX),
  );
}
