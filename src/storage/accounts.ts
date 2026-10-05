import { z } from "zod";

const SETTINGS_KEY = "settings";
const ACCOUNT_PROFILE_KEY_PREFIX = "account:profile:";
const ACCOUNT_AUTH_KEY_PREFIX = "account:auth:";
const ACCOUNT_INSTALLATIONS_KEY_PREFIX = "account:installations:";
const ACCOUNT_RECORD_KEY_PREFIXES = [
  ACCOUNT_PROFILE_KEY_PREFIX,
  ACCOUNT_AUTH_KEY_PREFIX,
  ACCOUNT_INSTALLATIONS_KEY_PREFIX,
] as const;

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

const githubUserIdSchema = z.number().int().positive();

const accountProfileSchema = z.object({
  id: z.string(),
  // Stable GitHub identity. Optional only for records written before it was
  // stored; those are backfilled from the next /user response.
  userId: githubUserIdSchema.optional(),
  // Display field. GitHub logins can change after a rename.
  login: z.string(),
  avatarUrl: z.string().url().nullable(),
  createdAt: z.number(),
});

const accountAuthSchema = z.object({
  token: z.string(),
  credentialGeneration: z.string().min(1).optional(),
  // Non-secret login receipt, written atomically with credentials. A restored
  // device flow can identify an already committed account without re-committing.
  connectionAttemptId: z.string().min(1).optional(),
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
      ...(account.userId != null ? { userId: account.userId } : {}),
      login: account.login,
      avatarUrl: account.avatarUrl,
      createdAt: account.createdAt,
    },
    auth: {
      token: account.token,
      credentialGeneration: account.credentialGeneration,
      connectionAttemptId: account.connectionAttemptId,
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

// A worker restart always scans once, including records orphaned before this
// cleanup existed. A failed owner operation requests another scan so a failed
// fragment deletion is retried before the next account mutation.
let accountRecordCleanupPending = true;

async function cleanupOrphanedAccountRecords(
  accountIds: string[],
): Promise<void> {
  if (!accountRecordCleanupPending) return;

  const registeredIds = new Set(accountIds);
  const keys = Object.keys(await browser.storage.local.get(null));
  const orphanedKeys = keys.filter((key) => {
    const prefix = ACCOUNT_RECORD_KEY_PREFIXES.find((candidate) =>
      key.startsWith(candidate),
    );
    return prefix != null && !registeredIds.has(key.slice(prefix.length));
  });
  if (orphanedKeys.length > 0) {
    await browser.storage.local.remove(orphanedKeys);
  }
  accountRecordCleanupPending = false;
}

/** Revision of an account whose stored record this release cannot parse. */
const QUARANTINED_GENERATION = "quarantined";

/**
 * Read-only projection of a registered account whose fragments fail to parse,
 * for example after rolling back to a release that predates a schema or enum
 * addition. The stored fragments stay untouched so a later release that can
 * parse them restores the account; until then the account is presented as
 * needing sign-in and never exposes or reuses its stored credentials.
 */
function quarantinedAccount(
  accountId: string,
  input: { profile: unknown; installations: unknown },
): Account {
  const profile =
    input.profile != null && typeof input.profile === "object"
      ? (input.profile as Record<string, unknown>)
      : {};
  const avatarUrl = accountProfileSchema.shape.avatarUrl.safeParse(
    profile.avatarUrl,
  );
  const userId = githubUserIdSchema.safeParse(profile.userId);
  const installations = accountInstallationsSchema.safeParse(
    input.installations,
  );
  return {
    id: accountId,
    ...(userId.success ? { userId: userId.data } : {}),
    login:
      typeof profile.login === "string" && profile.login.length > 0
        ? profile.login
        : accountId,
    avatarUrl: avatarUrl.success ? avatarUrl.data : null,
    createdAt:
      typeof profile.createdAt === "number" &&
      Number.isFinite(profile.createdAt)
        ? profile.createdAt
        : 0,
    token: "",
    credentialGeneration: QUARANTINED_GENERATION,
    invalidated: true,
    invalidatedReason: "unknown",
    refreshToken: null,
    expiresAt: null,
    refreshTokenExpiresAt: null,
    installations: installations.success
      ? installations.data.installations
      : [],
    installationsRefreshedAt: installations.success
      ? installations.data.installationsRefreshedAt
      : 0,
  };
}

/**
 * Registered IDs fall into three groups. Parseable accounts are `validIds`.
 * Unparseable records stay registered (quarantined) and are listed as
 * invalidated. Only IDs with no stored fragment at all leave `retainedIds`.
 */
async function loadAccountsByIds(accountIds: string[]): Promise<{
  accounts: Account[];
  validIds: string[];
  retainedIds: string[];
}> {
  if (accountIds.length === 0) {
    return { accounts: [], validIds: [], retainedIds: [] };
  }

  const result = await browser.storage.local.get(
    accountIds.flatMap((accountId) => accountStorageKeys(accountId)),
  );

  const accounts: Account[] = [];
  const validIds: string[] = [];
  const retainedIds: string[] = [];
  for (const accountId of new Set(accountIds)) {
    const fragments = {
      profile: result[accountProfileKey(accountId)],
      auth: result[accountAuthKey(accountId)],
      installations: result[accountInstallationsKey(accountId)],
    };
    if (Object.values(fragments).every((fragment) => fragment === undefined)) {
      continue;
    }
    const account = composeAccount(fragments);
    retainedIds.push(accountId);
    if (account == null || account.id !== accountId) {
      accounts.push(quarantinedAccount(accountId, fragments));
      continue;
    }
    accounts.push(account);
    validIds.push(accountId);
  }

  return { accounts, validIds, retainedIds };
}

// Queries are read-only in every extension context. Only the background commit
// owner below may migrate/repair storage; a query must never write an old index.
async function readRegistry(): Promise<{
  settings: ExtensionSettings;
  legacyAccounts?: Account[];
  /** A stored index this release cannot parse, e.g. after a rollback. */
  unrecognized?: true;
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
  return raw === undefined
    ? { settings: EMPTY_SETTINGS }
    : { settings: EMPTY_SETTINGS, unrecognized: true };
}

/** IDs that still have at least one stored account fragment. */
async function storedAccountIds(): Promise<string[]> {
  const ids = new Set<string>();
  for (const key of Object.keys(await browser.storage.local.get(null))) {
    const prefix = ACCOUNT_RECORD_KEY_PREFIXES.find((candidate) =>
      key.startsWith(candidate),
    );
    if (prefix != null) ids.add(key.slice(prefix.length));
  }
  return [...ids];
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
  const registry = await readRegistry();
  let settings = registry.settings;
  const { legacyAccounts } = registry;
  if (registry.unrecognized) {
    // Treating an unreadable index as empty would delete every account's
    // fragments as orphans. Rebuild the index from the stored records instead;
    // unparseable ones are then quarantined like any other.
    settings = { version: 4, accountIds: await storedAccountIds() };
    console.warn(
      "[accounts] stored account index could not be parsed; rebuilt it from stored account records.",
    );
    await writeSettings(settings);
  }
  if (legacyAccounts) {
    settings = await migrateAccounts(
      legacyAccounts.map((account) => ({
        ...account,
        credentialGeneration: credentialGeneration(account),
      })),
    );
  }
  const { accounts, validIds, retainedIds } = await loadAccountsByIds(
    settings.accountIds,
  );
  const quarantinedIds = retainedIds.filter((id) => !validIds.includes(id));
  if (quarantinedIds.length > 0) {
    console.warn(
      `[accounts] ${quarantinedIds.length} stored account record(s) could not be parsed; kept unchanged and shown as needing sign-in.`,
    );
  }
  const migrations = accounts.filter(
    (a) => validIds.includes(a.id) && a.credentialGeneration == null,
  );
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
  // Only IDs without any stored fragment leave the index; there is nothing
  // left to delete for them. Unparseable records stay registered.
  if (retainedIds.length !== settings.accountIds.length) {
    await writeSettings({ version: 4, accountIds: retainedIds });
  }
  await cleanupOrphanedAccountRecords(retainedIds);
}

// Initialization and repair run once per worker activation. Any failed owner
// operation (a failed write or cleanup) clears this so the next commit
// re-verifies the registry and rescans for orphaned fragments.
let registryVerified = false;

// Background-only commit boundary. Never hold it across HTTP. All callers use
// this one queue, including initialization, identity resolution and auth CAS.
// There is no account-lock acquisition inside a commit (one lock ordering).
let commitTail: Promise<unknown> = Promise.resolve();
function commit<T>(
  operation: () => Promise<T>,
  options: { reverify?: boolean } = {},
): Promise<T> {
  const result = commitTail.then(async () => {
    try {
      if (
        options.reverify === true ||
        !registryVerified ||
        accountRecordCleanupPending
      ) {
        registryVerified = false;
        await initializeAccountsUnlocked();
        registryVerified = true;
      }
      return await operation();
    } catch (error) {
      registryVerified = false;
      accountRecordCleanupPending = true;
      throw error;
    }
  });
  commitTail = result.catch(() => undefined);
  return result;
}

/**
 * Upsert an account by its numeric GitHub user id.
 *
 * A record matches when it stores the same user id, or when it predates the
 * stored id and has the same login (case-insensitive). Login is only a display
 * field: a renamed user updates the existing record instead of creating a
 * second one, and a different user who reuses a login gets a separate record
 * from every record that already stores an id.
 *
 * A match keeps its id and createdAt but swaps in the freshly obtained auth
 * (token, refreshToken, expiresAt, refreshTokenExpiresAt), installations and
 * profile, and stores the user id. The invalidated flag is cleared so the
 * account becomes active again. If several records match, preserve the
 * earliest one and drop the extras.
 *
 * If no account matches, append as a new account.
 *
 * `installations: null` means sign-in could not load them. A match then keeps
 * its stored installations; a new account starts with none, never refreshed.
 *
 * Returns the resulting Account (either the updated existing one or the
 * newly appended one).
 */
async function upsertAccountByLoginUnlocked(input: {
  userId: number;
  login: string;
  avatarUrl: string | null;
  token: string;
  refreshToken: string | null;
  expiresAt: number | null;
  refreshTokenExpiresAt: number | null;
  installations: Installation[] | null;
  newAccountId: string;
  now: number;
  connectionAttemptId?: string;
}): Promise<Account> {
  const { settings, matches } = await findAccountsByIdentity(input);
  const existing = matches[0] ?? null;

  if (existing != null) {
    const updated: Account = {
      ...existing,
      // Keep id + createdAt. Refresh the login from the fresh GitHub profile;
      // it may differ in casing or after a rename.
      userId: input.userId,
      login: input.login,
      avatarUrl: input.avatarUrl,
      token: input.token,
      credentialGeneration: crypto.randomUUID(),
      connectionAttemptId: input.connectionAttemptId,
      refreshToken: input.refreshToken,
      expiresAt: input.expiresAt,
      refreshTokenExpiresAt: input.refreshTokenExpiresAt,
      invalidated: false,
      invalidatedReason: null,
      ...(input.installations == null
        ? {}
        : {
            installations: input.installations,
            installationsRefreshedAt: input.now,
          }),
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
    userId: input.userId,
    login: input.login,
    avatarUrl: input.avatarUrl,
    createdAt: input.now,
    token: input.token,
    credentialGeneration: crypto.randomUUID(),
    connectionAttemptId: input.connectionAttemptId,
    refreshToken: input.refreshToken,
    expiresAt: input.expiresAt,
    refreshTokenExpiresAt: input.refreshTokenExpiresAt,
    invalidated: false,
    invalidatedReason: null,
    installations: input.installations ?? [],
    installationsRefreshedAt: input.installations == null ? 0 : input.now,
  };
  await writeAccounts(
    { version: 4, accountIds: [...settings.accountIds, account.id] },
    [account],
  );
  return account;
}

async function findAccountsByIdentity(identity: {
  userId: number;
  login: string;
}): Promise<{
  settings: ExtensionSettings;
  accounts: Account[];
  validIds: string[];
  matches: Account[];
}> {
  let settings = await getSettings();
  const { accounts, validIds, retainedIds } = await loadAccountsByIds(
    settings.accountIds,
  );
  if (retainedIds.length !== settings.accountIds.length) {
    settings = { version: 4, accountIds: retainedIds };
    await writeSettings(settings);
  }

  const normalized = identity.login.toLowerCase();
  // Prefer readable records over quarantined ones, then the earliest.
  const unreadable = (account: Account) =>
    validIds.includes(account.id) ? 0 : 1;
  return {
    settings,
    accounts,
    validIds,
    matches: accounts
      .filter((account) =>
        account.userId != null
          ? account.userId === identity.userId
          : account.login.toLowerCase() === normalized,
      )
      .sort(
        (a, b) => unreadable(a) - unreadable(b) || a.createdAt - b.createdAt,
      ),
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

export type AccountUserIdentity = {
  userId: number;
  login: string;
  avatarUrl: string | null;
};

/**
 * Store the user id from a later /user response on a record that predates it.
 * Only the revision that made the request may commit, and an id already stored
 * is never replaced. If another readable record already holds the id (the user
 * renamed and signed in again before this backfill), both are one GitHub user.
 * A valid holder is kept and gets the current login and avatar, and this record
 * is dropped; an invalidated holder is dropped instead. This background path
 * never touches a quarantined record.
 */
async function backfillUserIdUnlocked(
  accountId: string,
  expectedGeneration: string,
  user: AccountUserIdentity,
): Promise<"committed" | "merged" | "skipped"> {
  const { settings, accounts, validIds } = await findAccountsByIdentity(user);
  const current = accounts.find((account) => account.id === accountId);
  if (
    current == null ||
    current.invalidated ||
    current.userId != null ||
    credentialGeneration(current) !== expectedGeneration
  )
    return "skipped";

  const holder = accounts.find(
    (account) =>
      account.id !== accountId &&
      account.userId === user.userId &&
      validIds.includes(account.id),
  );
  const dropId = holder == null || holder.invalidated ? holder?.id : accountId;
  if (dropId != null) {
    await writeSettings({
      version: 4,
      accountIds: settings.accountIds.filter((id) => id !== dropId),
    });
    await browser.storage.local.remove(accountStorageKeys(dropId));
  }
  if (holder != null && dropId === accountId) {
    await writeProfileIdentity(holder.id, user);
    return "merged";
  }
  return (await writeProfileIdentity(accountId, user))
    ? "committed"
    : "skipped";
}

async function writeProfileIdentity(
  accountId: string,
  user: AccountUserIdentity,
): Promise<boolean> {
  const key = accountProfileKey(accountId);
  const profile = accountProfileSchema.safeParse(
    (await browser.storage.local.get(key))[key],
  );
  if (!profile.success) return false;
  await browser.storage.local.set({
    [key]: {
      ...profile.data,
      userId: user.userId,
      login: user.login,
      avatarUrl: user.avatarUrl,
    },
  });
  return true;
}

async function replaceInstallationsUnlocked(
  accountId: string,
  installations: Installation[],
): Promise<"committed" | "skipped"> {
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
    return "skipped";
  }

  await browser.storage.local.set({
    [accountInstallationsKey(accountId)]: {
      installations,
      installationsRefreshedAt: Date.now(),
    },
  });
  return "committed";
}

async function markAccountInvalidatedUnlocked(
  accountId: string,
  reason: "revoked" | "expired" | "refresh_failed" | "unknown",
): Promise<void> {
  const result = await browser.storage.local.get(accountAuthKey(accountId));
  const parsed = accountAuthSchema.safeParse(result[accountAuthKey(accountId)]);
  if (!parsed.success) {
    console.warn(
      `[accounts] commitAuth invalidation skipped for ${accountId}: stored auth record is missing or malformed.`,
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
      `[accounts] commitAuth token write skipped for ${accountId}: stored auth record is missing or malformed.`,
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
// Auth writes have no unconditional export: they go through
// accountMutations.commitAuth, which checks the credential generation.
export const upsertAccountByLogin = (
  input: AccountConnectInput,
): Promise<Account> => commit(() => upsertAccountByLoginUnlocked(input));
export const removeAccount = (id: string): Promise<void> =>
  commit(() => removeAccountUnlocked(id));
export const replaceInstallations = (
  id: string,
  installations: Installation[],
  expectedGeneration?: string,
  mayCommit?: () => boolean,
): Promise<"committed" | "skipped"> =>
  commit(async () => {
    const account = await getAccountById(id);
    if (
      expectedGeneration != null &&
      (account == null ||
        credentialGeneration(account) !== expectedGeneration ||
        account.invalidated)
    )
      return "skipped";
    // A newer installation refresh can supersede an old 401 retry while this
    // commit is queued. Check its liveness inside the same owner boundary.
    if (mayCommit != null && !mayCommit()) return "skipped";
    return replaceInstallationsUnlocked(id, installations);
  });

export const accountMutations = {
  /** Once per worker activation; always re-verifies the registry. */
  initialize: (): Promise<void> => commit(async () => {}, { reverify: true }),
  listAccounts: (): Promise<Account[]> => commit(listAccounts),
  getAccountById: (id: string): Promise<Account | null> =>
    commit(() => getAccountById(id)),
  upsertAccountByLogin,
  removeAccount,
  replaceInstallations,
  backfillUserId: (
    id: string,
    expectedGeneration: string,
    user: AccountUserIdentity,
  ): Promise<"committed" | "merged" | "skipped"> =>
    commit(() => backfillUserIdUnlocked(id, expectedGeneration, user)),
  /** Return the current record, including when an obsolete commit is skipped. */
  commitAuth: (
    id: string,
    expectedGeneration: string,
    change:
      | { tokens: AccountTokens }
      | { invalidatedReason: AccountInvalidationReason },
    mayCommit?: () => boolean,
  ): Promise<Account | null> =>
    commit(async () => {
      const current = await getAccountById(id);
      if (
        current == null ||
        current.invalidated ||
        credentialGeneration(current) !== expectedGeneration ||
        (mayCommit != null && !mayCommit())
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
