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
  return Object.keys(changes).some(
    (key) => key === SETTINGS_KEY || key.startsWith(ACCOUNT_KEY_PREFIX),
  );
}
