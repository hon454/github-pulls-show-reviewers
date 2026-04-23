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
    .enum(["revoked", "expired", "refresh_failed", "unknown"])
    .nullable()
    .default(null),
  refreshToken: z.string().nullable().default(null),
  expiresAt: z.number().nullable().default(null),
  refreshTokenExpiresAt: z.number().nullable().default(null),
});

const extensionSettingsSchemaV3 = z.object({
  version: z.literal(3),
  accounts: z.array(accountSchema),
});

const legacyAccountSchemaV2 = z.object({
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

const extensionSettingsSchemaV2 = z.object({
  version: z.literal(2),
  accounts: z.array(legacyAccountSchemaV2),
});

export type Installation = z.infer<typeof installationSchema>;
export type Account = z.infer<typeof accountSchema>;
export type ExtensionSettings = z.infer<typeof extensionSettingsSchemaV3>;

const EMPTY_SETTINGS: ExtensionSettings = { version: 3, accounts: [] };

export async function getSettings(): Promise<ExtensionSettings> {
  const result = await browser.storage.local.get(SETTINGS_KEY);
  const raw = result[SETTINGS_KEY];

  const v3 = extensionSettingsSchemaV3.safeParse(raw);
  if (v3.success) {
    return v3.data;
  }

  const v2 = extensionSettingsSchemaV2.safeParse(raw);
  if (v2.success) {
    const migrated: ExtensionSettings = {
      version: 3,
      accounts: v2.data.accounts.map((account) => ({
        ...account,
        refreshToken: null,
        expiresAt: null,
        refreshTokenExpiresAt: null,
      })),
    };
    await writeSettings(migrated);
    return migrated;
  }

  return EMPTY_SETTINGS;
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
    version: 3,
    accounts: [...settings.accounts, account],
  };
  await writeSettings(next);
}

export async function removeAccount(id: string): Promise<void> {
  const settings = await getSettings();
  const next: ExtensionSettings = {
    version: 3,
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
    version: 3,
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
  reason: "revoked" | "expired" | "refresh_failed" | "unknown",
): Promise<void> {
  const settings = await getSettings();
  const next: ExtensionSettings = {
    version: 3,
    accounts: settings.accounts.map((account) =>
      account.id === accountId
        ? { ...account, invalidated: true, invalidatedReason: reason }
        : account,
    ),
  };
  await writeSettings(next);
}

export async function updateAccountTokens(
  accountId: string,
  tokens: {
    token: string;
    refreshToken: string | null;
    expiresAt: number | null;
    refreshTokenExpiresAt: number | null;
  },
): Promise<void> {
  const settings = await getSettings();
  const next: ExtensionSettings = {
    version: 3,
    accounts: settings.accounts.map((account) =>
      account.id === accountId
        ? {
            ...account,
            token: tokens.token,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
            refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
          }
        : account,
    ),
  };
  await writeSettings(next);
}

export async function resolveAccountForRepo(
  owner: string,
  repo: string,
): Promise<Account | null> {
  const normalizedOwner = owner.toLowerCase();
  const normalizedRepo = repo.toLowerCase();
  const normalizedFullName = `${normalizedOwner}/${normalizedRepo}`;

  const accounts = await listAccounts();
  for (const account of accounts) {
    if (account.invalidated) {
      continue;
    }
    for (const installation of account.installations) {
      if (installation.account.login.toLowerCase() !== normalizedOwner) {
        continue;
      }
      if (installation.repositorySelection === "all") {
        return account;
      }
      const fullNames = installation.repoFullNames ?? [];
      if (fullNames.some((name) => name.toLowerCase() === normalizedFullName)) {
        return account;
      }
    }
  }
  return null;
}
