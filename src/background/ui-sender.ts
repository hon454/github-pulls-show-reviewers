export type UISender = {
  id?: string | undefined;
  url?: string | undefined;
  documentId?: string | undefined;
  frameId?: number | undefined;
  tab?: { id?: number | undefined } | undefined;
};
export type UIContext = {
  kind: "options" | "content";
  documentId: string;
  url: URL;
  tabId?: number | undefined;
};

export function identifyUIContext(
  sender: UISender | undefined,
): UIContext | null {
  if (sender?.id !== browser.runtime.id || !sender.documentId || !sender.url)
    return null;
  try {
    const url = new URL(sender.url);
    const options = new URL(browser.runtime.getURL("/options.html"));
    if (
      url.protocol === options.protocol &&
      url.host === options.host &&
      url.pathname === options.pathname &&
      url.search === "" &&
      url.hash === ""
    ) {
      return { kind: "options", documentId: sender.documentId, url };
    }
    if (
      url.origin === "https://github.com" &&
      sender.tab?.id != null &&
      sender.frameId === 0
    ) {
      return {
        kind: "content",
        documentId: sender.documentId,
        url,
        tabId: sender.tab.id,
      };
    }
  } catch {
    /* A malformed sender is never a privileged context. */
  }
  return null;
}

export function ownsRepository(
  context: UIContext,
  owner: string,
  repo: string,
): boolean {
  if (context.kind === "options") return true;
  const segments = context.url.pathname.split("/");
  return (
    segments[1]?.toLowerCase() === owner.toLowerCase() &&
    segments[2]?.toLowerCase() === repo.toLowerCase()
  );
}

/**
 * Chrome keeps reporting the URL a content document was loaded with in
 * `sender.url`; it does not follow `history.pushState`. GitHub navigates within
 * the document, so a pull list reached that way is not named by the sender
 * URL. Before refusing, check the URL the sender's tab has committed. Only a
 * top-frame content sender reaches this, so that URL belongs to its document.
 */
export async function ownsCommittedRepository(
  context: UIContext,
  owner: string,
  repo: string,
): Promise<boolean> {
  if (ownsRepository(context, owner, repo)) return true;
  if (context.kind !== "content" || context.tabId === undefined) return false;
  try {
    const tab = await browser.tabs?.get?.(context.tabId);
    if (!tab?.url) return false;
    const url = new URL(tab.url);
    return (
      url.origin === "https://github.com" &&
      ownsRepository({ ...context, url }, owner, repo)
    );
  } catch {
    return false;
  }
}
