// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const validateGitHubRepositoryAccessMock = vi.fn();
const getAccountByIdMock = vi.fn();
const markAccountInvalidatedMock = vi.fn();
const runtimeSendMessageMock = vi.fn();

vi.mock("../src/github/api", () => ({
  validateGitHubRepositoryAccess: validateGitHubRepositoryAccessMock,
  GitHubApiError: class GitHubApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly details?: string,
    ) {
      super(`GitHub API request failed with status ${status}.`);
      this.name = "GitHubApiError";
    }
  },
  GitHubPullRequestEndpointsError: class GitHubPullRequestEndpointsError extends Error {
    constructor(public readonly failures: unknown[]) {
      super("GitHub pull request endpoint diagnostics failed.");
      this.name = "GitHubPullRequestEndpointsError";
    }
  },
}));

vi.mock("../src/storage/accounts", () => ({
  getAccountById: getAccountByIdMock,
  markAccountInvalidated: markAccountInvalidatedMock,
}));

const { validateRepositoryAccessWithAccount } = await import(
  "../src/auth/account-token-refresh"
);

type StoredAccount = {
  id: string;
  login: string;
  token: string;
  refreshToken: string | null;
};

const baseAccount: StoredAccount = {
  id: "acc-1",
  login: "octocat",
  token: "ghu_stale",
  refreshToken: "ghr_valid",
};

beforeEach(() => {
  validateGitHubRepositoryAccessMock.mockReset();
  getAccountByIdMock.mockReset();
  markAccountInvalidatedMock.mockReset();
  runtimeSendMessageMock.mockReset();
  vi.stubGlobal("browser", {
    runtime: { sendMessage: runtimeSendMessageMock },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("validateRepositoryAccessWithAccount", () => {
  it("returns the first result when validation succeeds", async () => {
    const success = {
      ok: true,
      authMode: "token",
      outcome: "accessible",
      fullName: "octo/repo",
      pullNumber: "1",
      message: "ok",
    };
    validateGitHubRepositoryAccessMock.mockResolvedValueOnce(success);

    const result = await validateRepositoryAccessWithAccount({
      account: baseAccount as never,
      repository: "octo/repo",
    });

    expect(result).toBe(success);
    expect(runtimeSendMessageMock).not.toHaveBeenCalled();
    expect(markAccountInvalidatedMock).not.toHaveBeenCalled();
  });

  it("returns the first result when the failure is not token-invalid", async () => {
    const failure = {
      ok: false,
      authMode: "token",
      outcome: "token-not-found",
      fullName: "octo/repo",
      message: "not found",
    };
    validateGitHubRepositoryAccessMock.mockResolvedValueOnce(failure);

    const result = await validateRepositoryAccessWithAccount({
      account: baseAccount as never,
      repository: "octo/repo",
    });

    expect(result).toBe(failure);
    expect(runtimeSendMessageMock).not.toHaveBeenCalled();
  });

  it("refreshes and retries on token-invalid, returning the retry success", async () => {
    validateGitHubRepositoryAccessMock
      .mockResolvedValueOnce({
        ok: false,
        authMode: "token",
        outcome: "token-invalid",
        fullName: "octo/repo",
        message: "token invalid",
      })
      .mockResolvedValueOnce({
        ok: true,
        authMode: "token",
        outcome: "accessible",
        fullName: "octo/repo",
        pullNumber: "1",
        message: "ok",
      });
    runtimeSendMessageMock.mockResolvedValueOnce({
      ok: true,
      token: "ghu_fresh",
    });
    getAccountByIdMock.mockResolvedValueOnce({
      ...baseAccount,
      token: "ghu_fresh",
    });

    const result = await validateRepositoryAccessWithAccount({
      account: baseAccount as never,
      repository: "octo/repo",
    });

    expect(result.ok).toBe(true);
    expect(runtimeSendMessageMock).toHaveBeenCalledWith({
      type: "refreshAccessToken",
      accountId: "acc-1",
    });
    expect(markAccountInvalidatedMock).not.toHaveBeenCalled();
    const retryCall = validateGitHubRepositoryAccessMock.mock.calls[1];
    expect((retryCall[0] as { token: string }).token).toBe("ghu_fresh");
  });

  it("invalidates the account when retry still returns token-invalid", async () => {
    const retryFailure = {
      ok: false,
      authMode: "token",
      outcome: "token-invalid",
      fullName: "octo/repo",
      message: "still bad",
    };
    validateGitHubRepositoryAccessMock
      .mockResolvedValueOnce({
        ok: false,
        authMode: "token",
        outcome: "token-invalid",
        fullName: "octo/repo",
        message: "token invalid",
      })
      .mockResolvedValueOnce(retryFailure);
    runtimeSendMessageMock.mockResolvedValueOnce({
      ok: true,
      token: "ghu_fresh",
    });
    getAccountByIdMock.mockResolvedValueOnce({
      ...baseAccount,
      token: "ghu_fresh",
    });

    const result = await validateRepositoryAccessWithAccount({
      account: baseAccount as never,
      repository: "octo/repo",
    });

    expect(result).toBe(retryFailure);
    expect(markAccountInvalidatedMock).toHaveBeenCalledWith(
      "acc-1",
      "revoked",
    );
  });

  it("returns the first failure when refresh responds with ok:false", async () => {
    const firstFailure = {
      ok: false,
      authMode: "token",
      outcome: "token-invalid",
      fullName: "octo/repo",
      message: "token invalid",
    };
    validateGitHubRepositoryAccessMock.mockResolvedValueOnce(firstFailure);
    runtimeSendMessageMock.mockResolvedValueOnce({
      ok: false,
      terminal: true,
    });

    const result = await validateRepositoryAccessWithAccount({
      account: baseAccount as never,
      repository: "octo/repo",
    });

    expect(result).toBe(firstFailure);
    expect(validateGitHubRepositoryAccessMock).toHaveBeenCalledTimes(1);
    expect(markAccountInvalidatedMock).not.toHaveBeenCalled();
  });

  it("invalidates immediately when the account has no refresh token", async () => {
    const failure = {
      ok: false,
      authMode: "token",
      outcome: "token-invalid",
      fullName: "octo/repo",
      message: "token invalid",
    };
    validateGitHubRepositoryAccessMock.mockResolvedValueOnce(failure);

    const result = await validateRepositoryAccessWithAccount({
      account: { ...baseAccount, refreshToken: null } as never,
      repository: "octo/repo",
    });

    expect(result).toBe(failure);
    expect(runtimeSendMessageMock).not.toHaveBeenCalled();
    expect(markAccountInvalidatedMock).toHaveBeenCalledWith("acc-1", "revoked");
  });
});
