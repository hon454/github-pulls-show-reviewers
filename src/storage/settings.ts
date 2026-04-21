export type TokenEntry = {
  id: string;
  scope: string;
  token: string;
  label: string | null;
};

export type ExtensionSettings = {
  tokenEntries: TokenEntry[];
};

const SETTINGS_KEY = "settings";

export async function getStoredSettings(): Promise<ExtensionSettings> {
  const result = await browser.storage.local.get(SETTINGS_KEY);
  const settings = result[SETTINGS_KEY] as
    | Partial<ExtensionSettings>
    | { githubToken?: string | null }
    | undefined;
  const rawTokenEntries = (settings as Partial<ExtensionSettings> | undefined)
    ?.tokenEntries;

  return {
    tokenEntries: Array.isArray(rawTokenEntries)
      ? rawTokenEntries.filter(isTokenEntry)
      : [],
  };
}

export async function saveStoredSettings(settings: ExtensionSettings): Promise<void> {
  await browser.storage.local.set({
    [SETTINGS_KEY]: settings,
  });
}

function isTokenEntry(value: unknown): value is TokenEntry {
  if (typeof value !== "object" || value == null) {
    return false;
  }

  const entry = value as Partial<TokenEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.scope === "string" &&
    typeof entry.token === "string" &&
    (typeof entry.label === "string" || entry.label === null)
  );
}
