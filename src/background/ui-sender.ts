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
      return { kind: "content", documentId: sender.documentId, url };
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
