import { z } from "zod";

const SETTINGS_KEY = "settings";
const ACCOUNT_PROFILE_KEY_PREFIX = "account:profile:";
const ACCOUNT_AUTH_KEY_PREFIX = "account:auth:";
const ACCOUNT_INSTALLATIONS_KEY_PREFIX = "account:installations:";

const installationBaseSchema = z.object({
  id: z.number().int().positive(),
  account: z.object({
    login: z.string(),
    type: z.enum(["User", "Organization"]),
    avatarUrl: z.string().url().nullable(),
  }),
});

const repoSnapshotSchema = z.object({
  fullNames: z.array(z.string()),
  completeness: z.enum(["complete", "truncated"]),
});

const canonicalInstallationSchema = z.discriminatedUnion(
  "repositorySelection",
  [
    installationBaseSchema.extend({
      repositorySelection: z.literal("all"),
      repoSnapshot: z.null(),
    }),
    installationBaseSchema.extend({
      repositorySelection: z.literal("selected"),
      repoSnapshot: repoSnapshotSchema,
    }),
  ],
);

const legacyAllInstallationSchema = installationBaseSchema
  .extend({
    repositorySelection: z.literal("all"),
    repoFullNames: z.null().optional(),
  })
  .strict()
  .transform((installation) => {
    return {
      id: installation.id,
      account: installation.account,
      repositorySelection: "all" as const,
      repoSnapshot: null,
    };
  });

const legacySelectedInstallationSchema = installationBaseSchema
  .extend({
    repositorySelection: z.literal("selected"),
    repoFullNames: z.array(z.string()),
  })
  .strict()
  .transform((installation) => {
    return {
      id: installation.id,
      account: installation.account,
      repositorySelection: "selected" as const,
      repoSnapshot: {
        fullNames: installation.repoFullNames ?? [],
        completeness: "complete" as const,
      },
    };
  });

export const installationSchema = z.union([
  canonicalInstallationSchema,
  legacyAllInstallationSchema,
  legacySelectedInstallationSchema,
]);

const accountProfileSchema = z.object({
  id: z.string(),
  login: z.string(),
  avatarUrl: z.string().url().nullable(),
  createdAt: z.number(),
});

const accountAuthSchema = z.object({
  token: z.string(),
  credentialGeneration: z.string().min(1).optional(),
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
export type AccountCoverageResolution =
  | { status: "covered"; account: Account }
  | { status: "maybe-covered-truncated"; account: Account }
  | { status: "uncovered" };

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
      credentialGeneration: account.credentialGeneration,
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
  const installations = accountInstallationsSchema.safeParse(
    input.installations,
  );

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

async function migrateAccounts(
  accounts: Account[],
): Promise<ExtensionSettings> {
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
  for (const accountId of new Set(accountIds)) {
    const account = composeAccount({
      profile: result[accountProfileKey(accountId)],
      auth: result[accountAuthKey(accountId)],
      installations: result[accountInstallationsKey(accountId)],
    });
    if (account == null || account.id !== accountId) {
      continue;
    }
    accounts.push(account);
    validIds.push(accountId);
  }

  return { accounts, validIds };
}

// Queries are read-only in every extension context. Only the background commit
// owner below may migrate/repair storage; a query must never write an old index.
async function readRegistry(): Promise<{
  settings: ExtensionSettings;
  legacyAccounts?: Account[];
}> {
  const result = await browser.storage.local.get(SETTINGS_KEY);
  const raw = result[SETTINGS_KEY];
  const v4 = extensionSettingsSchemaV4.safeParse(raw);
  if (v4.success) return { settings: v4.data };
  const legacy = extensionSettingsSchemaV3.safeParse(raw);
  if (legacy.success) {
    return {
      settings: {
        version: 4,
        accountIds: legacy.data.accounts.map((a) => a.id),
      },
      legacyAccounts: legacy.data.accounts,
    };
  }
  const v2 = extensionSettingsSchemaV2.safeParse(raw);
  if (v2.success) {
    const accounts = v2.data.accounts.map((account) => ({
      ...account,
      refreshToken: null,
      expiresAt: null,
      refreshTokenExpiresAt: null,
    }));
    return {
      settings: { version: 4, accountIds: accounts.map((a) => a.id) },
      legacyAccounts: accounts,
    };
  }
  return { settings: EMPTY_SETTINGS };
}

export async function getSettings(): Promise<ExtensionSettings> {
  return (await readRegistry()).settings;
}

export async function listAccounts(): Promise<Account[]> {
  const { settings, legacyAccounts } = await readRegistry();
  const accounts =
    legacyAccounts ?? (await loadAccountsByIds(settings.accountIds)).accounts;
  return [...accounts].sort((a, b) => a.createdAt - b.createdAt);
}

export async function getAccountById(
  accountId: string,
): Promise<Account | null> {
  const { settings, legacyAccounts } = await readRegistry();
  if (!settings.accountIds.includes(accountId)) return null;
  if (legacyAccounts)
    return legacyAccounts.find((a) => a.id === accountId) ?? null;
  return (await loadAccountsByIds([accountId])).accounts[0] ?? null;
}

/** Stable identity for pre-migration snapshots; never derived from a secret. */
export function credentialGeneration(account: Account): string {
  return account.credentialGeneration ?? "legacy";
}

async function initializeAccountsUnlocked(): Promise<void> {
  const { settings, legacyAccounts } = await readRegistry();
  if (legacyAccounts) {
    await migrateAccounts(
      legacyAccounts.map((account) => ({
        ...account,
        credentialGeneration: credentialGeneration(account),
      })),
    );
    return;
  }
  const { accounts, validIds } = await loadAccountsByIds(settings.accountIds);
  const migrations = accounts.filter((a) => a.credentialGeneration == null);
  if (migrations.length > 0) {
    const keys = migrations.map((a) => accountAuthKey(a.id));
    const records = await browser.storage.local.get(keys);
    // Add only revision metadata. Rewriting profile/installations here would
    // trigger account-change listeners and cancel the request being recovered.
    await browser.storage.local.set(
      Object.fromEntries(
        migrations.map((a) => {
          const key = accountAuthKey(a.id);
          return [
            key,
            {
              ...(records[key] as Record<string, unknown>),
              credentialGeneration: credentialGeneration(a),
            },
          ];
        }),
      ),
    );
  }
  if (validIds.length !== settings.accountIds.length) {
    await writeSettings({ version: 4, accountIds: validIds });
    const removedIds = settings.accountIds.filter(
      (id) => !validIds.includes(id),
    );
    if (removedIds.length > 0) {
      await browser.storage.local.remove(
        removedIds.flatMap(accountStorageKeys),
      );
    }
  }
}

// Background-only commit boundary. Never hold it across HTTP. All callers use
// this one queue, including initialization, identity resolution and auth CAS.
// There is no account-lock acquisition inside a commit (one lock ordering).
let commitTail: Promise<unknown> = Promise.resolve();
function commit<T>(operation: () => Promise<T>): Promise<T> {
  const result = commitTail.then(async () => {
    await initializeAccountsUnlocked();
    return operation();
  });
  commitTail = result.catch(() => undefined);
  return result;
}

async function addAccountUnlocked(account: Account): Promise<void> {
  const settings = await getSettings();
  const next: ExtensionSettings = {
    version: 4,
    accountIds: [
      ...settings.accountIds.filter((id) => id !== account.id),
      account.id,
    ],
  };
  await writeAccounts(next, [
    { ...account, credentialGeneration: crypto.randomUUID() },
  ]);
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
async function upsertAccountByLoginUnlocked(input: {
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
      credentialGeneration: crypto.randomUUID(),
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
            accountIds: settings.accountIds.filter(
              (id) => !duplicateIds.includes(id),
            ),
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
    id: settings.accountIds.includes(input.newAccountId)
      ? crypto.randomUUID()
      : input.newAccountId,
    login: input.login,
    avatarUrl: input.avatarUrl,
    createdAt: input.now,
    token: input.token,
    credentialGeneration: crypto.randomUUID(),
    refreshToken: input.refreshToken,
    expiresAt: input.expiresAt,
    refreshTokenExpiresAt: input.refreshTokenExpiresAt,
    invalidated: false,
    invalidatedReason: null,
    installations: input.installations,
    installationsRefreshedAt: input.now,
  };
  await writeAccounts(
    { version: 4, accountIds: [...settings.accountIds, account.id] },
    [account],
  );
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
    matches: accounts
      .filter((account) => account.login.toLowerCase() === normalized)
      .sort((a, b) => a.createdAt - b.createdAt),
  };
}

async function removeAccountUnlocked(id: string): Promise<void> {
  const settings = await getSettings();
  const next: ExtensionSettings = {
    version: 4,
    accountIds: settings.accountIds.filter((accountId) => accountId !== id),
  };
  await writeSettings(next);
  await browser.storage.local.remove(accountStorageKeys(id));
}

async function replaceInstallationsUnlocked(
  accountId: string,
  installations: Installation[],
): Promise<void> {
  const result = await browser.storage.local.get(
    accountInstallationsKey(accountId),
  );
  const parsed = accountInstallationsSchema.safeParse(
    result[accountInstallationsKey(accountId)],
  );
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

async function markAccountInvalidatedUnlocked(
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

async function updateAccountTokensUnlocked(
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
      credentialGeneration: crypto.randomUUID(),
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    },
  });
}

export type AccountConnectInput = Parameters<
  typeof upsertAccountByLoginUnlocked
>[0];
export type AccountTokens = Parameters<typeof updateAccountTokensUnlocked>[1];
export type AccountInvalidationReason = NonNullable<
  Account["invalidatedReason"]
>;

// These storage mutation exports are background-only. Options must use the
// corresponding runtime/account-mutations wrappers, never a context-local queue.
export const addAccount = (account: Account): Promise<void> =>
  commit(() => addAccountUnlocked(account));
export const upsertAccountByLogin = (
  input: AccountConnectInput,
): Promise<Account> => commit(() => upsertAccountByLoginUnlocked(input));
export const removeAccount = (id: string): Promise<void> =>
  commit(() => removeAccountUnlocked(id));
export const replaceInstallations = (
  id: string,
  installations: Installation[],
  expectedGeneration?: string,
): Promise<void> =>
  commit(async () => {
    const account = await getAccountById(id);
    if (
      expectedGeneration != null &&
      (account == null ||
        credentialGeneration(account) !== expectedGeneration ||
        account.invalidated)
    )
      return;
    await replaceInstallationsUnlocked(id, installations);
  });
export const markAccountInvalidated = (
  id: string,
  reason: AccountInvalidationReason,
): Promise<void> => commit(() => markAccountInvalidatedUnlocked(id, reason));
export const updateAccountTokens = (
  id: string,
  tokens: AccountTokens,
): Promise<void> => commit(() => updateAccountTokensUnlocked(id, tokens));

export const accountMutations = {
  initialize: (): Promise<void> => commit(async () => {}),
  listAccounts: (): Promise<Account[]> => commit(listAccounts),
  getAccountById: (id: string): Promise<Account | null> =>
    commit(() => getAccountById(id)),
  upsertAccountByLogin,
  removeAccount,
  replaceInstallations,
  /** Return the current record, including when an obsolete commit is skipped. */
  commitAuth: (
    id: string,
    expectedGeneration: string,
    change:
      | { tokens: AccountTokens }
      | { invalidatedReason: AccountInvalidationReason },
  ): Promise<Account | null> =>
    commit(async () => {
      const current = await getAccountById(id);
      if (
        current == null ||
        current.invalidated ||
        credentialGeneration(current) !== expectedGeneration
      ) {
        return current;
      }
      if ("tokens" in change)
        await updateAccountTokensUnlocked(id, change.tokens);
      else await markAccountInvalidatedUnlocked(id, change.invalidatedReason);
      return getAccountById(id);
    }),
};

export async function resolveAccountCoverageForRepo(
  owner: string,
  repo: string,
): Promise<AccountCoverageResolution> {
  const normalizedOwner = owner.toLowerCase();
  const normalizedRepo = repo.toLowerCase();
  const normalizedFullName = `${normalizedOwner}/${normalizedRepo}`;

  const accounts = await listAccounts();
  let truncatedCandidate: Account | null = null;
  for (const account of accounts) {
    if (account.invalidated) {
      continue;
    }
    for (const installation of account.installations) {
      if (installation.account.login.toLowerCase() !== normalizedOwner) {
        continue;
      }
      if (installation.repositorySelection === "all") {
        return { status: "covered", account };
      }
      if (
        installation.repoSnapshot.fullNames.some(
          (name) => name.toLowerCase() === normalizedFullName,
        )
      ) {
        return { status: "covered", account };
      }
      if (
        installation.repoSnapshot.completeness === "truncated" &&
        truncatedCandidate == null
      ) {
        truncatedCandidate = account;
      }
    }
  }
  if (truncatedCandidate != null) {
    return { status: "maybe-covered-truncated", account: truncatedCandidate };
  }
  return { status: "uncovered" };
}

export async function resolveAccountForRepo(
  owner: string,
  repo: string,
): Promise<Account | null> {
  const resolution = await resolveAccountCoverageForRepo(owner, repo);
  return resolution.status === "uncovered" ? null : resolution.account;
}
