import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DeviceFlowError,
  GitHubAuthSchemaError,
  fetchAuthenticatedUser,
  fetchInstallationRepositories,
  fetchUserInstallations,
  initiateDeviceFlow,
  pollForAccessToken,
} from "../src/github/auth";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`./fixtures/github-api/${name}`, import.meta.url),
      "utf8",
    ),
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("initiateDeviceFlow", () => {
  it("posts client_id to /login/device/code and returns parsed payload", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(fixture("device-code-init.json")));
    const result = await initiateDeviceFlow({ clientId: "Iv1.test" });
    expect(result.userCode).toBe("WDJB-MJHT");
    expect(result.deviceCode).toBe(
      "3584d83530557fdd1f46af8289938c8ef79f9dc5",
    );
    expect(result.interval).toBe(5);
    expect(result.expiresIn).toBe(900);
    expect(result.verificationUri).toBe("https://github.com/login/device");
    const [[url, init]] = fetchMock.mock.calls;
    expect(url).toBe("https://github.com/login/device/code");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ Accept: "application/json" });
    expect(String(init?.body)).toContain("client_id=Iv1.test");
  });
});

describe("pollForAccessToken", () => {
  it("returns the access token on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(fixture("access-token-success.json")),
    );
    const result = await pollForAccessToken({
      clientId: "Iv1.test",
      deviceCode: "abc",
    });
    expect(result).toEqual({
      status: "success",
      accessToken: "ghu_exampletoken",
      refreshToken: null,
      expiresAt: null,
      refreshTokenExpiresAt: null,
    });
  });

  it("captures refresh fields and computes absolute expiry timestamps when present", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T00:00:00.000Z"));
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(fixture("refresh-token-success.json")),
    );
    const result = await pollForAccessToken({
      clientId: "Iv1.test",
      deviceCode: "abc",
    });
    expect(result).toEqual({
      status: "success",
      accessToken: "ghu_newaccess",
      refreshToken: "ghr_newrefresh",
      expiresAt: Date.UTC(2026, 3, 23, 0, 0, 0) + 28_800_000,
      refreshTokenExpiresAt: Date.UTC(2026, 3, 23, 0, 0, 0) + 15_897_600_000,
    });
  });

  it("returns a pending status when authorization_pending", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(fixture("access-token-pending.json")),
    );
    const result = await pollForAccessToken({
      clientId: "Iv1.test",
      deviceCode: "abc",
    });
    expect(result).toEqual({ status: "pending" });
  });

  it("returns a slow_down status with the new interval", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(fixture("access-token-slow-down.json")),
    );
    const result = await pollForAccessToken({
      clientId: "Iv1.test",
      deviceCode: "abc",
    });
    expect(result).toEqual({ status: "slow_down", interval: 10 });
  });

  it("throws a terminal DeviceFlowError for expired_token", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(fixture("access-token-expired.json")))
      .mockResolvedValueOnce(jsonResponse(fixture("access-token-expired.json")));
    await expect(
      pollForAccessToken({ clientId: "Iv1.test", deviceCode: "abc" }),
    ).rejects.toBeInstanceOf(DeviceFlowError);
    await expect(
      pollForAccessToken({ clientId: "Iv1.test", deviceCode: "abc" }),
    ).rejects.toMatchObject({ code: "expired_token" });
  });

  it("throws a terminal DeviceFlowError for access_denied", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(fixture("access-token-denied.json")),
    );
    await expect(
      pollForAccessToken({ clientId: "Iv1.test", deviceCode: "abc" }),
    ).rejects.toMatchObject({ code: "access_denied" });
  });

  it("throws a terminal DeviceFlowError for device_flow_disabled", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ error: "device_flow_disabled" }),
    );
    await expect(
      pollForAccessToken({ clientId: "Iv1.test", deviceCode: "abc" }),
    ).rejects.toMatchObject({ code: "device_flow_disabled" });
  });

  it("throws a network error wrapped in DeviceFlowError on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("server down", { status: 503 }),
    );
    await expect(
      pollForAccessToken({ clientId: "Iv1.test", deviceCode: "abc" }),
    ).rejects.toMatchObject({ code: "network_error" });
  });
});

function paginatedResponse(body: unknown, linkNext?: string): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (linkNext) {
    headers["link"] = `<${linkNext}>; rel="next"`;
  }
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function installationPage(id: number): unknown {
  return {
    total_count: 2,
    installations: [
      {
        id,
        account: {
          login: `org-${id}`,
          type: "Organization",
          avatar_url: null,
        },
        repository_selection: "all",
      },
    ],
  };
}

function repositoryPage(fullName: string): unknown {
  return {
    total_count: 2,
    repositories: [{ full_name: fullName }],
  };
}

function invalidPaginationTargets(expectedPathname: string) {
  return [
    {
      caseLabel: "malformed",
      nextUrl: "not a URL",
    },
    {
      caseLabel: "credential-bearing",
      nextUrl: `https://attacker:secret@api.github.com${expectedPathname}?page=2`,
    },
    {
      caseLabel: "fragment-bearing",
      nextUrl: `https://api.github.com${expectedPathname}?page=2#unexpected`,
    },
    {
      caseLabel: "HTTP",
      nextUrl: `http://api.github.com${expectedPathname}?page=2`,
    },
    {
      caseLabel: "cross-origin",
      nextUrl: `https://example.com${expectedPathname}?page=2`,
    },
    {
      caseLabel: "non-default-port",
      nextUrl: `https://api.github.com:8443${expectedPathname}?page=2`,
    },
    {
      caseLabel: "wrong-path",
      nextUrl: `https://api.github.com${expectedPathname}/unexpected?page=2`,
    },
  ];
}

describe("fetchAuthenticatedUser", () => {
  it("parses login and avatar URL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(fixture("user.json")),
    );
    const user = await fetchAuthenticatedUser({ token: "ghu_abc" });
    expect(user.login).toBe("hon454");
    expect(user.avatarUrl).toBe(
      "https://avatars.githubusercontent.com/u/123?v=4",
    );
  });
});

describe("fetchUserInstallations", () => {
  it("returns installations with camelCase fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(fixture("user-installations.json")),
    );
    const result = await fetchUserInstallations({ token: "ghu_abc" });
    const installations = result.items;
    expect(result.truncated).toBe(false);
    expect(installations).toHaveLength(2);
    expect(installations[0]).toMatchObject({
      id: 12345,
      repositorySelection: "all",
    });
    expect(installations[0].account.login).toBe("hon454");
  });

  it("follows an exact installation endpoint next link with query parameters", async () => {
    const controller = new AbortController();
    const nextUrl =
      "https://api.github.com:443/user/installations?page=2&per_page=100";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(paginatedResponse(installationPage(1), nextUrl))
      .mockResolvedValueOnce(paginatedResponse(installationPage(2)));

    const result = await fetchUserInstallations({
      token: "ghu_abc",
      signal: controller.signal,
    });

    expect(result.items.map(({ id }) => id)).toEqual([1, 2]);
    expect(result.truncated).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(nextUrl);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init?.headers as Headers).get("Authorization")).toBe(
        "Bearer ghu_abc",
      );
      expect(init?.signal).toBe(controller.signal);
    }
  });

  it.each(invalidPaginationTargets("/user/installations"))(
    "rejects a $caseLabel installation next link without a second authenticated request",
    async ({ nextUrl }) => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(paginatedResponse(installationPage(1), nextUrl));

      const result = await fetchUserInstallations({ token: "ghu_abc" });

      expect(result.items.map(({ id }) => id)).toEqual([1]);
      expect(result.truncated).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(
        (fetchMock.mock.calls[0]?.[1]?.headers as Headers).get("Authorization"),
      ).toBe("Bearer ghu_abc");
    },
  );

  it("marks installation pagination truncated when the ceiling leaves a next page", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    for (let page = 1; page <= 10; page++) {
      fetchMock.mockResolvedValueOnce(
        paginatedResponse(
          {
            total_count: 1_001,
            installations: [
              {
                id: page,
                account: {
                  login: `org-${page}`,
                  type: "Organization",
                  avatar_url: null,
                },
                repository_selection: "all",
              },
            ],
          },
          `https://api.github.com/user/installations?page=${page + 1}&per_page=100`,
        ),
      );
    }

    const result = await fetchUserInstallations({ token: "ghu_abc" });

    expect(result.items).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });
});

describe("fetchInstallationRepositories", () => {
  it("returns an array of full_name strings", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(fixture("installation-repositories.json")),
    );
    const result = await fetchInstallationRepositories({
      token: "ghu_abc",
      installationId: 67890,
    });
    expect(result).toEqual({
      items: ["cinev/shotloom", "cinev/landing"],
      truncated: false,
    });
  });

  it("follows an exact selected-repository endpoint next link with query parameters", async () => {
    const controller = new AbortController();
    const nextUrl =
      "https://api.github.com:443/user/installations/1/repositories?page=2&per_page=100";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        paginatedResponse(repositoryPage("cinev/one"), nextUrl),
      )
      .mockResolvedValueOnce(paginatedResponse(repositoryPage("cinev/two")));

    const result = await fetchInstallationRepositories({
      token: "ghu_abc",
      installationId: 1,
      signal: controller.signal,
    });

    expect(result).toEqual({
      items: ["cinev/one", "cinev/two"],
      truncated: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(nextUrl);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init?.headers as Headers).get("Authorization")).toBe(
        "Bearer ghu_abc",
      );
      expect(init?.signal).toBe(controller.signal);
    }
  });

  it.each(invalidPaginationTargets("/user/installations/1/repositories"))(
    "rejects a $caseLabel selected-repository next link without a second authenticated request",
    async ({ nextUrl }) => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          paginatedResponse(repositoryPage("cinev/one"), nextUrl),
        );

      const result = await fetchInstallationRepositories({
        token: "ghu_abc",
        installationId: 1,
      });

      expect(result).toEqual({
        items: ["cinev/one"],
        truncated: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(
        (fetchMock.mock.calls[0]?.[1]?.headers as Headers).get("Authorization"),
      ).toBe("Bearer ghu_abc");
    },
  );

  it("marks selected-repository pagination truncated when the ceiling leaves a next page", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    for (let page = 1; page <= 10; page++) {
      fetchMock.mockResolvedValueOnce(
        paginatedResponse(
          {
            total_count: 1,
            repositories: [{ full_name: `cinev/repo-${page}` }],
          },
          `https://api.github.com/user/installations/1/repositories?page=${page + 1}&per_page=100`,
        ),
      );
    }
    const names = await fetchInstallationRepositories({
      token: "ghu_abc",
      installationId: 1,
    });
    expect(names.items).toHaveLength(10);
    expect(names.truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("throws on non-ok responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("unauthorized", { status: 401 }),
    );
    await expect(
      fetchInstallationRepositories({ token: "ghu_abc", installationId: 1 }),
    ).rejects.toThrow();
  });
});

describe("auth schema diagnostics", () => {
  it("throws GitHubAuthSchemaError when /user payload is malformed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ unexpected: true }),
    );
    await expect(
      fetchAuthenticatedUser({ token: "ghu_abc" }),
    ).rejects.toBeInstanceOf(GitHubAuthSchemaError);
  });

  it("throws GitHubAuthSchemaError when /user/installations payload is malformed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ installations: "not-an-array" }),
    );
    await expect(
      fetchUserInstallations({ token: "ghu_abc" }),
    ).rejects.toBeInstanceOf(GitHubAuthSchemaError);
  });

  it("throws GitHubAuthSchemaError when installation repositories payload is malformed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ repositories: [{ wrong: "shape" }] }),
    );
    await expect(
      fetchInstallationRepositories({ token: "ghu_abc", installationId: 1 }),
    ).rejects.toBeInstanceOf(GitHubAuthSchemaError);
  });
});
