import { z } from "zod";

const SETTINGS_KEY = "settings";

const installationSchema = z.object({
  id: z.number().int().positive(),
  account: z.object({
    login: z.string(),
    type: z.enum(["User", "Organization"]),
    avatarUrl: z.string().url().nullable(),
  }),
  repositorySelection: z.enum(["all", "selected"]),
  repoFullNames: z.array(z.string()).nullable(),
});

const accountSchema = z.object({
  id: z.string(),
  login: z.string(),
  avatarUrl: z.string().url().nullable(),
  token: z.string(),
  createdAt: z.number(),
  installations: z.array(installationSchema),
  installationsRefreshedAt: z.number(),
  invalidated: z.boolean().default(false),
  invalidatedReason: z
    .enum(["revoked", "expired", "unknown"])
    .nullable()
    .default(null),
});

const extensionSettingsSchema = z.object({
  version: z.literal(2),
  accounts: z.array(accountSchema),
});

export type Installation = z.infer<typeof installationSchema>;
export type Account = z.infer<typeof accountSchema>;
export type ExtensionSettings = z.infer<typeof extensionSettingsSchema>;

const EMPTY_SETTINGS: ExtensionSettings = { version: 2, accounts: [] };

export async function getSettings(): Promise<ExtensionSettings> {
  const result = await browser.storage.local.get(SETTINGS_KEY);
  const parsed = extensionSettingsSchema.safeParse(result[SETTINGS_KEY]);
  return parsed.success ? parsed.data : EMPTY_SETTINGS;
}

async function writeSettings(settings: ExtensionSettings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
}

export async function listAccounts(): Promise<Account[]> {
  const settings = await getSettings();
  return [...settings.accounts].sort((a, b) => a.createdAt - b.createdAt);
}

export async function addAccount(account: Account): Promise<void> {
  const settings = await getSettings();
  const next: ExtensionSettings = {
    version: 2,
    accounts: [...settings.accounts, account],
  };
  await writeSettings(next);
}

export async function removeAccount(id: string): Promise<void> {
  const settings = await getSettings();
  const next: ExtensionSettings = {
    version: 2,
    accounts: settings.accounts.filter((account) => account.id !== id),
  };
  await writeSettings(next);
}

export async function replaceInstallations(
  accountId: string,
  installations: Installation[],
): Promise<void> {
  const settings = await getSettings();
  const next: ExtensionSettings = {
    version: 2,
    accounts: settings.accounts.map((account) =>
      account.id === accountId
        ? {
            ...account,
            installations,
            installationsRefreshedAt: Date.now(),
          }
        : account,
    ),
  };
  await writeSettings(next);
}

export async function markAccountInvalidated(
  accountId: string,
  reason: "revoked" | "expired" | "unknown",
): Promise<void> {
  const settings = await getSettings();
  const next: ExtensionSettings = {
    version: 2,
    accounts: settings.accounts.map((account) =>
      account.id === accountId
        ? { ...account, invalidated: true, invalidatedReason: reason }
        : account,
    ),
  };
  await writeSettings(next);
}
