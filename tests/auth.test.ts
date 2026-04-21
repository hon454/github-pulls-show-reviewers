import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DeviceFlowError,
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
    expect(result).toEqual({ status: "success", accessToken: "ghu_exampletoken" });
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
    const installations = await fetchUserInstallations({ token: "ghu_abc" });
    expect(installations).toHaveLength(2);
    expect(installations[0]).toMatchObject({
      id: 12345,
      repositorySelection: "all",
    });
    expect(installations[0].account.login).toBe("hon454");
  });
});

describe("fetchInstallationRepositories", () => {
  it("returns an array of full_name strings", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(fixture("installation-repositories.json")),
    );
    const names = await fetchInstallationRepositories({
      token: "ghu_abc",
      installationId: 67890,
    });
    expect(names).toEqual(["cinev/shotloom", "cinev/landing"]);
  });

  it("follows pagination up to the 10-page ceiling", async () => {
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
    expect(names).toHaveLength(10);
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
