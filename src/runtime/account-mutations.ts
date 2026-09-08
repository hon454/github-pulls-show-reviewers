import { z } from "zod";
import { requestCapability } from "./ui-client";

export async function removeAccount(accountId: string): Promise<void> {
  await requestCapability({ type: "removeAccount", accountId }, z.null());
}
