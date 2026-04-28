import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RefreshTokenError, refreshAccessToken } from "../src/github/auth";

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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-23T00:00:00.000Z"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("refreshAccessToken", () => {
  it("posts grant_type=refresh_token and returns rotated tokens with absolute expiries", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(fixture("refresh-token-success.json")));

    const result = await refreshAccessToken({
      clientId: "Iv1.test",
      refreshToken: "ghr_old",
    });

    expect(result).toEqual({
      accessToken: "ghu_newaccess",
      refreshToken: "ghr_newrefresh",
      expiresAt: Date.UTC(2026, 3, 23, 0, 0, 0) + 28_800_000,
      refreshTokenExpiresAt: Date.UTC(2026, 3, 23, 0, 0, 0) + 15_897_600_000,
    });

    const [[url, init]] = fetchMock.mock.calls;
    expect(url).toBe("https://github.com/login/oauth/access_token");
    expect(init?.method).toBe("POST");
    const body = String(init?.body);
    expect(body).toContain("client_id=Iv1.test");
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=ghr_old");
  });

  it("returns null refresh fields when the success response omits refresh_token rotation", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        access_token: "ghu_newaccess",
        expires_in: 28800,
        scope: "",
        token_type: "bearer",
      }),
    );

    const result = await refreshAccessToken({
      clientId: "Iv1.test",
      refreshToken: "ghr_old",
    });

    expect(result).toEqual({
      accessToken: "ghu_newaccess",
      refreshToken: null,
      expiresAt: Date.UTC(2026, 3, 23, 0, 0, 0) + 28_800_000,
      refreshTokenExpiresAt: null,
    });
  });

  it("throws RefreshTokenError(terminal) for bad_refresh_token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(fixture("refresh-token-bad.json")),
    );

    await expect(
      refreshAccessToken({ clientId: "Iv1.test", refreshToken: "ghr_old" }),
    ).rejects.toMatchObject({
      name: "RefreshTokenError",
      kind: "terminal",
      code: "bad_refresh_token",
    });
  });

  it("throws RefreshTokenError(transient) on a 5xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("server down", { status: 503 }),
    );

    await expect(
      refreshAccessToken({ clientId: "Iv1.test", refreshToken: "ghr_old" }),
    ).rejects.toMatchObject({
      name: "RefreshTokenError",
      kind: "transient",
    });
  });

  it("throws RefreshTokenError(terminal) when a 4xx body carries a terminal OAuth error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(fixture("refresh-token-bad.json"), 401),
    );

    await expect(
      refreshAccessToken({ clientId: "Iv1.test", refreshToken: "ghr_old" }),
    ).rejects.toMatchObject({
      name: "RefreshTokenError",
      kind: "terminal",
      code: "bad_refresh_token",
    });
  });

  it("throws RefreshTokenError(terminal) for HTTP 400 without a parseable body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("bad request", { status: 400 }),
    );

    await expect(
      refreshAccessToken({ clientId: "Iv1.test", refreshToken: "ghr_old" }),
    ).rejects.toMatchObject({
      name: "RefreshTokenError",
      kind: "terminal",
      code: "http_error",
    });
  });

  it("throws RefreshTokenError(terminal) for HTTP 401 without a parseable body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("unauthorized", { status: 401 }),
    );

    await expect(
      refreshAccessToken({ clientId: "Iv1.test", refreshToken: "ghr_old" }),
    ).rejects.toMatchObject({
      name: "RefreshTokenError",
      kind: "terminal",
      code: "http_error",
    });
  });

  it("throws RefreshTokenError(transient) for HTTP 429 (rate limit)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("slow down", { status: 429 }),
    );

    await expect(
      refreshAccessToken({ clientId: "Iv1.test", refreshToken: "ghr_old" }),
    ).rejects.toMatchObject({
      name: "RefreshTokenError",
      kind: "transient",
      code: "http_error",
    });
  });

  it("throws RefreshTokenError(transient) when fetch itself rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("offline"));

    await expect(
      refreshAccessToken({ clientId: "Iv1.test", refreshToken: "ghr_old" }),
    ).rejects.toMatchObject({
      name: "RefreshTokenError",
      kind: "transient",
      code: "network_error",
    });
  });

  it("throws RefreshTokenError(transient) for malformed JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("<html>not json</html>", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      refreshAccessToken({ clientId: "Iv1.test", refreshToken: "ghr_old" }),
    ).rejects.toMatchObject({
      name: "RefreshTokenError",
      kind: "transient",
    });
  });

  it("RefreshTokenError exposes name, kind, and code", () => {
    const error = new RefreshTokenError("terminal", "bad_refresh_token");
    expect(error.name).toBe("RefreshTokenError");
    expect(error.kind).toBe("terminal");
    expect(error.code).toBe("bad_refresh_token");
    expect(error.message).toContain("bad_refresh_token");
  });
});
