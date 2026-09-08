import {
  resolveAccountForRepo,
  resolveFallbackAccount,
} from "../../runtime/accounts";

/** Account selection, migration and bounded installation self-healing are background-owned. */
export function createSelfHealingAccountResolver() {
  return { resolveAccount: resolveAccountForRepo, resolveFallbackAccount };
}
