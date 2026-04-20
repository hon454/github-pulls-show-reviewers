export type ExtensionSettings = {
  githubToken: string | null;
};

const SETTINGS_KEY = "settings";

export async function getStoredSettings(): Promise<ExtensionSettings> {
  const result = await browser.storage.local.get(SETTINGS_KEY);
  const settings = result[SETTINGS_KEY] as ExtensionSettings | undefined;

  return {
    githubToken: settings?.githubToken ?? null,
  };
}

export async function saveStoredSettings(settings: ExtensionSettings): Promise<void> {
  await browser.storage.local.set({
    [SETTINGS_KEY]: settings,
  });
}
