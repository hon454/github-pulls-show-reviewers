import { JWT } from "google-auth-library";
import {
  ChromeWebStoreV2,
  ChromeWebStoreUploadStateError,
} from "publish-browser-extension";
import { z } from "zod";

import { parse, ReleaseError, requireCondition } from "./policy.ts";
import type { StorePort } from "./engine.ts";

export function createCwsAdapter(
  config: {
    publisherId: string;
    itemId: string;
    email: string;
    privateKey: string;
    zip: string;
  },
  fetcher: typeof fetch = fetch,
): StorePort & { dryRun(): Promise<void> } {
  requireCondition(
    config.email && config.privateKey,
    "CWS service-account configuration is missing.",
  );
  const name = `publishers/${config.publisherId}/items/${config.itemId}`;
  const auth = new JWT({
    email: config.email,
    key: config.privateKey,
    scopes: ["https://www.googleapis.com/auth/chromewebstore"],
  });
  const uploader = new ChromeWebStoreV2({
    apiVersion: "v2",
    publisherId: config.publisherId,
    extensionId: config.itemId,
    serviceAccountClientEmail: config.email,
    serviceAccountPrivateKey: config.privateKey,
    zip: config.zip,
    skipSubmitReview: true,
    cancelPending: false,
    skipReview: false,
    publishType: "DEFAULT_PUBLISH",
  });
  async function request(
    method: "GET" | "POST",
    operation: "fetchStatus" | "publish",
  ) {
    try {
      // Only authentication uses Google's library. Native fetch performs exactly
      // one CWS request: no gaxios auth replay or automatic mutation retries.
      const { token } = await auth.getAccessToken();
      requireCondition(token, "CWS authentication returned no access token.");
      const response = await fetcher(
        `https://chromewebstore.googleapis.com/v2/${name}:${operation}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          ...(method === "POST"
            ? {
                body: JSON.stringify({
                  publishType: "DEFAULT_PUBLISH",
                  skipReview: false,
                  blockOnWarnings: true,
                }),
              }
            : {}),
          signal: AbortSignal.timeout(60_000),
          redirect: "error",
        },
      );
      requireCondition(
        response.ok,
        `CWS ${operation} did not confirm success (HTTP ${response.status}); inspect state before another write.`,
      );
      return (await response.json()) as unknown;
    } catch (error) {
      if (error instanceof ReleaseError) throw error;
      throw new ReleaseError(
        `CWS ${operation} outcome is unknown; inspect state before another write.`,
      );
    }
  }
  return {
    status: () => request("GET", "fetchStatus"),
    async dryRun() {
      try {
        await uploader.submit(true);
        await request("GET", "fetchStatus");
      } catch {
        throw new ReleaseError(
          "Credential-only verification failed; no upload or publish was attempted.",
        );
      }
    },
    async upload() {
      try {
        // Public SDK equivalent of --chrome-skip-submit-review, NOT skip-review.
        await uploader.submit(false);
        return "SUCCEEDED";
      } catch (error) {
        if (error instanceof ChromeWebStoreUploadStateError) {
          const cause = z
            .object({ uploadState: z.literal("IN_PROGRESS") })
            .safeParse(error.cause);
          if (cause.success) return "IN_PROGRESS";
        }
        throw new ReleaseError(
          "Upload outcome is unknown or unsuccessful; inspect the dashboard and receipt without reuploading.",
        );
      }
    },
    async publish() {
      const result = parse(
        z.object({
          name: z.string(),
          itemId: z.string(),
          state: z.enum(["PENDING_REVIEW", "PUBLISHED"]),
        }),
        await request("POST", "publish"),
        "CWS publish response",
      );
      requireCondition(
        result.name === name && result.itemId === config.itemId,
        "CWS publish response identity mismatch; inspect remote state.",
      );
    },
  };
}
