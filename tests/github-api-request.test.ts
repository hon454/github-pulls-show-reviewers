import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  collectGitHubApiPages,
  createGitHubHeaders,
  parseNextPageUrl,
} from "../src/github/api/request";

const endpoint = {
  name: "reviews" as const,
  method: "GET" as const,
  path: "/repos/acme/widgets/pulls/42/reviews",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GitHub API request helpers", () => {
  it("adds authorization only when a token is present", () => {
    expect(createGitHubHeaders(null).get("Authorization")).toBeNull();
    expect(createGitHubHeaders("ghu_example").get("Authorization")).toBe(
      "Bearer ghu_example",
    );
  });

  it("accepts only next links on the expected GitHub API origin and path", () => {
    const expectedPath = endpoint.path;
    const valid = `https://api.github.com${expectedPath}?page=2`;

    expect(parseNextPageUrl(`<${valid}>; rel="next"`, expectedPath)).toBe(
      valid,
    );
    expect(
      parseNextPageUrl(
        `<https://example.com${expectedPath}?page=2>; rel="next"`,
        expectedPath,
      ),
    ).toBeNull();
    expect(
      parseNextPageUrl(
        `<https://api.github.com/repos/acme/widgets/issues/42/events?page=2>; rel="next"`,
        expectedPath,
      ),
    ).toBeNull();
    expect(
      parseNextPageUrl(
        `<https://user:secret@api.github.com${expectedPath}?page=2>; rel="next"`,
        expectedPath,
      ),
    ).toBeNull();
  });

  it("stops pagination at the caller-provided page budget", async () => {
    const pageTwo = `https://api.github.com${endpoint.path}?page=2`;
    const pageThree = `https://api.github.com${endpoint.path}?page=3`;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify([{ id: 2 }]), {
        status: 200,
        headers: {
          Link: `<${pageThree}>; rel="next"`,
        },
      }),
    );

    const result = await collectGitHubApiPages({
      firstResponse: new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: {
          Link: `<${pageTwo}>; rel="next"`,
        },
      }),
      endpoint,
      headers: createGitHubHeaders("ghu_example"),
      schema: z.array(z.object({ id: z.number() })),
      pageBudget: 2,
    });

    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      pageTwo,
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
  });

  it("stops early when the caller has collected enough records", async () => {
    const nextUrl = `https://api.github.com${endpoint.path}?page=2`;
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const result = await collectGitHubApiPages({
      firstResponse: new Response(JSON.stringify([{ id: 42 }]), {
        status: 200,
        headers: { Link: `<${nextUrl}>; rel="next"` },
      }),
      endpoint,
      headers: createGitHubHeaders(null),
      schema: z.array(z.object({ id: z.number() })),
      hasEnough: (records) => records.some(({ id }) => id === 42),
    });

    expect(result).toEqual([{ id: 42 }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
