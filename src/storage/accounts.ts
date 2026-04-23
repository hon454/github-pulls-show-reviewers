import { z } from "zod";

const SETTINGS_KEY = "settings";
const ACCOUNT_PROFILE_KEY_PREFIX = "account:profile:";
const ACCOUNT_AUTH_KEY_PREFIX = "account:auth:";
const ACCOUNT_INSTALLATIONS_KEY_PREFIX = "account:installations:";

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

const accountProfileSchema = z.object({
  id: z.string(),
  login: z.string(),
  avatarUrl: z.string().url().nullable(),
  createdAt: z.number(),
});

const accountAuthSchema = z.object({
  token: z.string(),
  invalidated: z.boolean().default(false),
  invalidatedReason: z
    .enum(["revoked", "expired", "refresh_failed", "unknown"])
    .nullable()
    .default(null),
  refreshToken: z.string().nullable().default(null),
  expiresAt: z.number().nullable().default(null),
  refreshTokenExpiresAt: z.number().nullable().default(null),
});

const accountInstallationsSchema = z.object({
  installations: z.array(installationSchema),
  installationsRefreshedAt: z.number(),
});

const accountSchema = accountProfileSchema
  .merge(accountAuthSchema)
  .merge(accountInstallationsSchema);

const extensionSettingsSchemaV4 = z.object({
  version: z.literal(4),
  accountIds: z.array(z.string()),
});

const legacyAccountSchemaV3 = accountSchema;

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

const extensionSettingsSchemaV3 = z.object({
  version: z.literal(3),
  accounts: z.array(legacyAccountSchemaV3),
});

const extensionSettingsSchemaV2 = z.object({
  version: z.literal(2),
  accounts: z.array(legacyAccountSchemaV2),
});

export type Installation = z.infer<typeof installationSchema>;
export type Account = z.infer<typeof accountSchema>;
export type ExtensionSettings = z.infer<typeof extensionSettingsSchemaV4>;

const EMPTY_SETTINGS: ExtensionSettings = { version: 4, accountIds: [] };

function accountProfileKey(accountId: string): string {
  return `${ACCOUNT_PROFILE_KEY_PREFIX}${accountId}`;
}

function accountAuthKey(accountId: string): string {
  return `${ACCOUNT_AUTH_KEY_PREFIX}${accountId}`;
}

function accountInstallationsKey(accountId: string): string {
  return `${ACCOUNT_INSTALLATIONS_KEY_PREFIX}${accountId}`;
}

function accountStorageKeys(accountId: string): [string, string, string] {
  return [
    accountProfileKey(accountId),
    accountAuthKey(accountId),
    accountInstallationsKey(accountId),
  ];
}

function decomposeAccount(account: Account) {
  return {
    profile: {
      id: account.id,
      login: account.login,
      avatarUrl: account.avatarUrl,
      createdAt: account.createdAt,
    },
    auth: {
      token: account.token,
      invalidated: account.invalidated,
      invalidatedReason: account.invalidatedReason,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
      refreshTokenExpiresAt: account.refreshTokenExpiresAt,
    },
    installations: {
      installations: account.installations,
      installationsRefreshedAt: account.installationsRefreshedAt,
    },
  };
}

function composeAccount(input: {
  profile: unknown;
  auth: unknown;
  installations: unknown;
}): Account | null {
  const profile = accountProfileSchema.safeParse(input.profile);
  const auth = accountAuthSchema.safeParse(input.auth);
  const installations = accountInstallationsSchema.safeParse(input.installations);

  if (!profile.success || !auth.success || !installations.success) {
    return null;
  }

  return {
    ...profile.data,
    ...auth.data,
    ...installations.data,
  };
}

async function writeSettings(settings: ExtensionSettings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
}

async function writeAccounts(
  settings: ExtensionSettings,
  accounts: Account[],
): Promise<void> {
  const payload: Record<string, unknown> = {
    [SETTINGS_KEY]: settings,
  };

  for (const account of accounts) {
    const fragments = decomposeAccount(account);
    payload[accountProfileKey(account.id)] = fragments.profile;
    payload[accountAuthKey(account.id)] = fragments.auth;
    payload[accountInstallationsKey(account.id)] = fragments.installations;
  }

  await browser.storage.local.set(payload);
}

async function migrateAccounts(accounts: Account[]): Promise<ExtensionSettings> {
  const settings: ExtensionSettings = {
    version: 4,
    accountIds: accounts.map((account) => account.id),
  };
  await writeAccounts(settings, accounts);
  return settings;
}

async function loadAccountsByIds(accountIds: string[]): Promise<{
  accounts: Account[];
  validIds: string[];
}> {
  if (accountIds.length === 0) {
    return { accounts: [], validIds: [] };
  }

  const result = await browser.storage.local.get(
    accountIds.flatMap((accountId) => accountStorageKeys(accountId)),
  );

  const accounts: Account[] = [];
  const validIds: string[] = [];
  for (const accountId of accountIds) {
    const account = composeAccount({
      profile: result[accountProfileKey(accountId)],
      auth: result[accountAuthKey(accountId)],
      installations: result[accountInstallationsKey(accountId)],
    });
    if (account == null) {
      continue;
    }
    accounts.push(account);
    validIds.push(accountId);
  }

  return { accounts, validIds };
}

export async function getSettings(): Promise<ExtensionSettings> {
  const result = await browser.storage.local.get(SETTINGS_KEY);
  const raw = result[SETTINGS_KEY];

  const v4 = extensionSettingsSchemaV4.safeParse(raw);
  if (v4.success) {
    return v4.data;
  }

  const v3 = extensionSettingsSchemaV3.safeParse(raw);
  if (v3.success) {
    return migrateAccounts(v3.data.accounts);
  }

  const v2 = extensionSettingsSchemaV2.safeParse(raw);
  if (v2.success) {
    return migrateAccounts(
      v2.data.accounts.map((account) => ({
        ...account,
        refreshToken: null,
        expiresAt: null,
        refreshTokenExpiresAt: null,
      })),
    );
  }

  return EMPTY_SETTINGS;
}

export async function listAccounts(): Promise<Account[]> {
  const settings = await getSettings();
  const { accounts, validIds } = await loadAccountsByIds(settings.accountIds);
  if (validIds.length !== settings.accountIds.length) {
    await writeSettings({ version: 4, accountIds: validIds });
  }
  return [...accounts].sort((a, b) => a.createdAt - b.createdAt);
}

export async function getAccountById(accountId: string): Promise<Account | null> {
  const result = await browser.storage.local.get(accountStorageKeys(accountId));
  return composeAccount({
    profile: result[accountProfileKey(accountId)],
    auth: result[accountAuthKey(accountId)],
    installations: result[accountInstallationsKey(accountId)],
  });
}

export async function addAccount(account: Account): Promise<void> {
  const settings = await getSettings();
  const next: ExtensionSettings = {
    version: 4,
    accountIds: [...settings.accountIds.filter((id) => id !== account.id), account.id],
  };
  await writeAccounts(next, [account]);
}

/**
 * Upsert an account by GitHub login (case-insensitive).
 *
 * If an account with the same login already exists, reuse its id and
 * createdAt but swap in the freshly obtained auth (token, refreshToken,
 * expiresAt, refreshTokenExpiresAt) and installations snapshot. The
 * invalidated flag is cleared so the account becomes active again. If
 * duplicate records already exist for the login, preserve the earliest
 * matching record and drop the extras.
 *
 * If no account matches the login, append as a new account.
 *
 * Returns the resulting Account (either the updated existing one or the
 * newly appended one).
 */
export async function upsertAccountByLogin(input: {
  login: string;
  avatarUrl: string | null;
  token: string;
  refreshToken: string | null;
  expiresAt: number | null;
  refreshTokenExpiresAt: number | null;
  installations: Installation[];
  newAccountId: string;
  now: number;
}): Promise<Account> {
  const { settings, matches } = await findAccountsByLogin(input.login);
  const existing = matches[0] ?? null;

  if (existing != null) {
    const updated: Account = {
      ...existing,
      // Keep id + createdAt. Refresh the login casing from the fresh
      // GitHub profile so subsequent lookups match what GitHub returns.
      login: input.login,
      avatarUrl: input.avatarUrl,
      token: input.token,
      refreshToken: input.refreshToken,
      expiresAt: input.expiresAt,
      refreshTokenExpiresAt: input.refreshTokenExpiresAt,
      invalidated: false,
      invalidatedReason: null,
      installations: input.installations,
      installationsRefreshedAt: input.now,
    };

    const duplicateIds = matches.slice(1).map((account) => account.id);
    const nextSettings: ExtensionSettings =
      duplicateIds.length === 0
        ? settings
        : {
            version: 4,
            accountIds: settings.accountIds.filter((id) => !duplicateIds.includes(id)),
          };

    // Preserve the retained account's position in the accountIds ordering.
    await writeAccounts(nextSettings, [updated]);
    if (duplicateIds.length > 0) {
      await browser.storage.local.remove(
        duplicateIds.flatMap((accountId) => accountStorageKeys(accountId)),
      );
    }
    return updated;
  }

  const account: Account = {
    id: input.newAccountId,
    login: input.login,
    avatarUrl: input.avatarUrl,
    createdAt: input.now,
    token: input.token,
    refreshToken: input.refreshToken,
    expiresAt: input.expiresAt,
    refreshTokenExpiresAt: input.refreshTokenExpiresAt,
    invalidated: false,
    invalidatedReason: null,
    installations: input.installations,
    installationsRefreshedAt: input.now,
  };
  await addAccount(account);
  return account;
}

async function findAccountsByLogin(login: string): Promise<{
  settings: ExtensionSettings;
  matches: Account[];
}> {
  let settings = await getSettings();
  const { accounts, validIds } = await loadAccountsByIds(settings.accountIds);
  if (validIds.length !== settings.accountIds.length) {
    settings = { version: 4, accountIds: validIds };
    await writeSettings(settings);
  }

  const normalized = login.toLowerCase();
  return {
    settings,
    matches: accounts.filter((account) => account.login.toLowerCase() === normalized),
  };
}

export async function removeAccount(id: string): Promise<void> {
  const settings = await getSettings();
  const next: ExtensionSettings = {
    version: 4,
    accountIds: settings.accountIds.filter((accountId) => accountId !== id),
  };
  await writeSettings(next);
  await browser.storage.local.remove(accountStorageKeys(id));
}

export async function replaceInstallations(
  accountId: string,
  installations: Installation[],
): Promise<void> {
  const result = await browser.storage.local.get(accountInstallationsKey(accountId));
  const parsed = accountInstallationsSchema.safeParse(result[accountInstallationsKey(accountId)]);
  if (!parsed.success) {
    console.warn(
      `[accounts] replaceInstallations skipped for ${accountId}: stored installations record is missing or malformed.`,
    );
    return;
  }

  await browser.storage.local.set({
    [accountInstallationsKey(accountId)]: {
      installations,
      installationsRefreshedAt: Date.now(),
    },
  });
}

export async function markAccountInvalidated(
  accountId: string,
  reason: "revoked" | "expired" | "refresh_failed" | "unknown",
): Promise<void> {
  const result = await browser.storage.local.get(accountAuthKey(accountId));
  const parsed = accountAuthSchema.safeParse(result[accountAuthKey(accountId)]);
  if (!parsed.success) {
    console.warn(
      `[accounts] markAccountInvalidated skipped for ${accountId}: stored auth record is missing or malformed.`,
    );
    return;
  }

  await browser.storage.local.set({
    [accountAuthKey(accountId)]: {
      ...parsed.data,
      invalidated: true,
      invalidatedReason: reason,
    },
  });
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
  const result = await browser.storage.local.get(accountAuthKey(accountId));
  const parsed = accountAuthSchema.safeParse(result[accountAuthKey(accountId)]);
  if (!parsed.success) {
    console.warn(
      `[accounts] updateAccountTokens skipped for ${accountId}: stored auth record is missing or malformed.`,
    );
    return;
  }

  await browser.storage.local.set({
    [accountAuthKey(accountId)]: {
      ...parsed.data,
      token: tokens.token,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    },
  });
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
