import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  token: vi.fn(async () => ({ token: "fake-access-token" })),
  submit: vi.fn(async (dryRun: boolean) => {
    void dryRun;
  }),
  options: vi.fn(),
  authOptions: vi.fn(),
}));
vi.mock("google-auth-library", () => ({
  JWT: class {
    constructor(options: unknown) {
      mocks.authOptions(options);
    }
    getAccessToken = mocks.token;
  },
}));
vi.mock("publish-browser-extension", () => ({
  ChromeWebStoreV2: class {
    constructor(options: unknown) {
      mocks.options(options);
    }
    submit = mocks.submit;
  },
  ChromeWebStoreUploadStateError: class extends Error {},
}));

import { createCwsAdapter } from "../scripts/release/cws.ts";

const config = {
  publisherId: "publisher",
  itemId: "a".repeat(32),
  email: "test@example.invalid",
  privateKey: "fake-key",
  zip: "/tmp/checked.zip",
};
const name = `publishers/${config.publisherId}/items/${config.itemId}`;
beforeEach(() => vi.clearAllMocks());

describe("public SDK upload and narrow CWS publish adapter", () => {
  it("uses only public upload configuration with review submission and cancellation disabled", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const adapter = createCwsAdapter(config, fetcher);
    expect(await adapter.upload()).toBe("SUCCEEDED");
    expect(mocks.options).toHaveBeenCalledWith(
      expect.objectContaining({
        skipSubmitReview: true,
        skipReview: false,
        cancelPending: false,
        zip: config.zip,
      }),
    );
    expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("publish-existing issues one publish request, never an upload, and retains normal review", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            name,
            itemId: config.itemId,
            state: "PENDING_REVIEW",
          }),
        ),
      );
    await createCwsAdapter(config, fetcher).publish();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `https://chromewebstore.googleapis.com/v2/${name}:publish`,
    );
    const options = fetcher.mock.calls[0]?.[1];
    expect(options?.method).toBe("POST");
    expect(JSON.parse(options?.body as string)).toEqual({
      publishType: "DEFAULT_PUBLISH",
      skipReview: false,
      blockOnWarnings: true,
    });
    expect(mocks.authOptions).toHaveBeenCalledWith({
      email: config.email,
      key: config.privateKey,
      scopes: ["https://www.googleapis.com/auth/chromewebstore"],
    });
  });
  it("credential-only mode checks both auth facilities without any mutation", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ name, itemId: config.itemId })),
      );
    await createCwsAdapter(config, fetcher).dryRun();
    expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toMatch(/:fetchStatus$/);
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("GET");
  });
  it("does not replay timeouts, HTTP errors, or malformed mutation responses", async () => {
    for (const response of [
      () => Promise.reject(new Error("secret-error-body")),
      () => Promise.resolve(new Response("secret-error-body", { status: 503 })),
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              name: "wrong",
              itemId: config.itemId,
              state: "PENDING_REVIEW",
            }),
          ),
        ),
      () => Promise.resolve(new Response("{}")),
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(response);
      await expect(
        createCwsAdapter(config, fetcher).publish(),
      ).rejects.toThrow();
      await createCwsAdapter(config, fetcher)
        .status()
        .catch((error) =>
          expect(String(error)).not.toContain("secret-error-body"),
        );
      expect(fetcher).toHaveBeenCalledTimes(2); // One explicit publish, one explicit read-only inspection.
      expect(mocks.submit).not.toHaveBeenCalled();
    }
  });
});
