import { z } from "zod";

export type DeviceFlowErrorCode =
  | "expired_token"
  | "access_denied"
  | "device_flow_disabled"
  | "unsupported_grant_type"
  | "incorrect_client_credentials"
  | "incorrect_device_code"
  | "network_error"
  | "invalid_response";

export class DeviceFlowError extends Error {
  constructor(
    public readonly code: DeviceFlowErrorCode,
    message?: string,
  ) {
    super(message ?? `Device flow error: ${code}`);
    this.name = "DeviceFlowError";
  }
}

const deviceCodeInitSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string().url(),
  expires_in: z.number(),
  interval: z.number(),
});

export type DeviceFlowInit = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

export async function initiateDeviceFlow(input: {
  clientId: string;
  signal?: AbortSignal;
}): Promise<DeviceFlowInit> {
  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ client_id: input.clientId }).toString(),
    signal: input.signal,
  });
  if (!response.ok) {
    throw new DeviceFlowError(
      "network_error",
      `Device code request failed with status ${response.status}.`,
    );
  }
  const payload = deviceCodeInitSchema.safeParse(await response.json());
  if (!payload.success) {
    throw new DeviceFlowError(
      "invalid_response",
      "Malformed device code response from GitHub.",
    );
  }
  const verificationUri = payload.data.verification_uri;
  const verificationUriComplete = `${verificationUri}?user_code=${encodeURIComponent(
    payload.data.user_code,
  )}`;
  return {
    deviceCode: payload.data.device_code,
    userCode: payload.data.user_code,
    verificationUri,
    verificationUriComplete,
    expiresIn: payload.data.expires_in,
    interval: payload.data.interval,
  };
}

const accessTokenResponseSchema = z.union([
  z.object({
    access_token: z.string(),
    token_type: z.string(),
    scope: z.string().optional(),
  }),
  z.object({
    error: z.string(),
    error_description: z.string().optional(),
    interval: z.number().optional(),
  }),
]);

export type AccessTokenPollResult =
  | { status: "success"; accessToken: string }
  | { status: "pending" }
  | { status: "slow_down"; interval: number };

const TERMINAL_POLL_ERRORS: DeviceFlowErrorCode[] = [
  "expired_token",
  "access_denied",
  "device_flow_disabled",
  "unsupported_grant_type",
  "incorrect_client_credentials",
  "incorrect_device_code",
];

export async function pollForAccessToken(input: {
  clientId: string;
  deviceCode: string;
  signal?: AbortSignal;
}): Promise<AccessTokenPollResult> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: input.clientId,
      device_code: input.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    signal: input.signal,
  });
  if (!response.ok) {
    throw new DeviceFlowError(
      "network_error",
      `Access token request failed with status ${response.status}.`,
    );
  }
  const payload = accessTokenResponseSchema.safeParse(await response.json());
  if (!payload.success) {
    throw new DeviceFlowError(
      "invalid_response",
      "Malformed access token response from GitHub.",
    );
  }

  if ("access_token" in payload.data) {
    return { status: "success", accessToken: payload.data.access_token };
  }

  if (payload.data.error === "authorization_pending") {
    return { status: "pending" };
  }

  if (payload.data.error === "slow_down") {
    return {
      status: "slow_down",
      interval: payload.data.interval ?? 0,
    };
  }

  if ((TERMINAL_POLL_ERRORS as string[]).includes(payload.data.error)) {
    throw new DeviceFlowError(
      payload.data.error as DeviceFlowErrorCode,
      payload.data.error_description,
    );
  }

  throw new DeviceFlowError(
    "invalid_response",
    `Unrecognized device flow error: ${payload.data.error}`,
  );
}

function createAuthHeaders(token: string): Headers {
  return new Headers({
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  });
}

function parseNextLink(header: string | null): string | null {
  if (header == null) {
    return null;
  }
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match) {
      return match[1];
    }
  }
  return null;
}

const githubUserSchema = z.object({
  login: z.string(),
  avatar_url: z.string().url().nullable().optional(),
});

export type AuthenticatedUser = {
  login: string;
  avatarUrl: string | null;
};

export async function fetchAuthenticatedUser(input: {
  token: string;
  signal?: AbortSignal;
}): Promise<AuthenticatedUser> {
  const response = await fetch("https://api.github.com/user", {
    headers: createAuthHeaders(input.token),
    signal: input.signal,
  });
  if (!response.ok) {
    throw new Error(`GET /user failed with status ${response.status}.`);
  }
  const payload = githubUserSchema.parse(await response.json());
  return {
    login: payload.login,
    avatarUrl: payload.avatar_url ?? null,
  };
}

const apiInstallationAccountSchema = z.object({
  login: z.string(),
  type: z.enum(["User", "Organization", "Bot"]),
  avatar_url: z.string().url().nullable().optional(),
});

const apiInstallationSchema = z.object({
  id: z.number(),
  account: apiInstallationAccountSchema,
  repository_selection: z.enum(["all", "selected"]),
});

const userInstallationsSchema = z.object({
  total_count: z.number(),
  installations: z.array(apiInstallationSchema),
});

export type ApiInstallation = {
  id: number;
  account: {
    login: string;
    type: "User" | "Organization";
    avatarUrl: string | null;
  };
  repositorySelection: "all" | "selected";
};

export const MAX_INSTALLATION_PAGES = 10;

export async function fetchUserInstallations(input: {
  token: string;
  signal?: AbortSignal;
}): Promise<ApiInstallation[]> {
  const results: ApiInstallation[] = [];
  let url: string | null =
    "https://api.github.com/user/installations?per_page=100";
  for (let page = 0; page < MAX_INSTALLATION_PAGES && url != null; page++) {
    const response = await fetch(url, {
      headers: createAuthHeaders(input.token),
      signal: input.signal,
    });
    if (!response.ok) {
      throw new Error(
        `GET /user/installations failed with status ${response.status}.`,
      );
    }
    const payload = userInstallationsSchema.parse(await response.json());
    for (const installation of payload.installations) {
      if (installation.account.type === "Bot") {
        continue;
      }
      results.push({
        id: installation.id,
        account: {
          login: installation.account.login,
          type: installation.account.type as "User" | "Organization",
          avatarUrl: installation.account.avatar_url ?? null,
        },
        repositorySelection: installation.repository_selection,
      });
    }
    url = parseNextLink(response.headers.get("link"));
  }
  return results;
}

const installationRepositoriesSchema = z.object({
  total_count: z.number(),
  repositories: z.array(z.object({ full_name: z.string() })),
});

export async function fetchInstallationRepositories(input: {
  token: string;
  installationId: number;
  signal?: AbortSignal;
}): Promise<string[]> {
  const results: string[] = [];
  let url: string | null = `https://api.github.com/user/installations/${input.installationId}/repositories?per_page=100`;
  for (let page = 0; page < MAX_INSTALLATION_PAGES && url != null; page++) {
    const response = await fetch(url, {
      headers: createAuthHeaders(input.token),
      signal: input.signal,
    });
    if (!response.ok) {
      throw new Error(
        `GET /user/installations/${input.installationId}/repositories failed with status ${response.status}.`,
      );
    }
    const payload = installationRepositoriesSchema.parse(
      await response.json(),
    );
    for (const repository of payload.repositories) {
      results.push(repository.full_name);
    }
    url = parseNextLink(response.headers.get("link"));
  }
  return results;
}
