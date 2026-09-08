import { accountMutations } from "../storage/accounts";

/** Per activation. A failed policy setup never admits a sensitive operation. */
export function createStoragePolicy() {
  let initialization: Promise<void> | undefined;
  return function ensureReady(): Promise<void> {
    if (!initialization) {
      initialization = (async () => {
        await browser.storage.local.setAccessLevel({
          accessLevel: "TRUSTED_CONTEXTS",
        });
        await browser.storage.session.setAccessLevel({
          accessLevel: "TRUSTED_CONTEXTS",
        });
        await accountMutations.initialize();
      })().catch(() => {
        initialization = undefined;
        throw new Error("trusted_storage_unavailable");
      });
    }
    return initialization;
  };
}
