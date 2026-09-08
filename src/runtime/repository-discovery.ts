import { z } from "zod";
import { opaqueIdSchema, repositoryContextSchema } from "./ui-contract";
import { requestCapability } from "./ui-client";
export const DISCOVERY_DOCUMENT_PROBE = "repositoryDiscoveryDocumentProbe";

/** Opaque admission identity. Only background can bind it to a sender document. */
export const repositoryDiscoverySchema = z.strictObject({
  id: opaqueIdSchema,
  generation: z.number().int().nonnegative(),
  ...repositoryContextSchema.shape,
});
export type RepositoryDiscovery = z.infer<typeof repositoryDiscoverySchema>;

export function beginRepositoryDiscovery(input: {
  owner: string;
  repo: string;
  pageSession: string;
  generation: number;
}) {
  return requestCapability(
    { type: "beginRepositoryDiscovery", ...input },
    repositoryDiscoverySchema,
  );
}

export function retireRepositoryDiscovery(
  discoveryId: string,
): Promise<unknown> {
  return requestCapability(
    { type: "retireRepositoryDiscovery", discoveryId },
    z.null(),
  );
}
