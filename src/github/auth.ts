import { z } from "zod";

import {
  CredentialTimeoutError,
  withCredentialTimeout,
  type CredentialTimer,
} from "../shared/credential-deadline";

type CredentialRequestOptions = {
  signal?: AbortSignal;
  timer?: CredentialTimer;
};

// The body is read inside the same bound as the request, so headers followed
// by a stalled body cannot hang the caller either.
function credentialRequest<T>(
  url: string,
  init: Omit<RequestInit, "signal">,
  options: CredentialRequestOptions,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  return withCredentialTimeout(
    async (signal) => read(await fetch(url, { ...init, signal })),
    options,
  );
}

// A timed-out OAuth exchange has an unknown outcome. It ends as the transient
// network error and is never replayed automatically.
function deviceFlowTimeout(request: string) {
  return (error: unknown): never => {
    if (error instanceof CredentialTimeoutError) {
      throw new DeviceFlowError("network_error", `${request} timed out.`);
    }
    throw error;
  };
}

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

export class GitHubAuthSchemaError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly issues?: unknown,
  ) {
    super(`GitHub returned an unexpected response shape for ${endpoint}.`);
    this.name = "GitHubAuthSchemaError";
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

export async function initiateDeviceFlow(
  input: { clientId: string } & CredentialRequestOptions,
): Promise<DeviceFlowInit> {
  const body = await credentialRequest(
    "https://github.com/login/device/code",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ client_id: input.clientId }).toString(),
    },
    input,
    async (response): Promise<unknown> => {
      if (!response.ok) {
        throw new DeviceFlowError(
          "network_error",
          `Device code request failed with status ${response.status}.`,
        );
      }
      return response.json();
    },
  ).catch(deviceFlowTimeout("Device code request"));
  const payload = deviceCodeInitSchema.safeParse(body);
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
    expires_in: z.number().optional(),
    refresh_token: z.string().optional(),
    refresh_token_expires_in: z.number().optional(),
  }),
  z.object({
    error: z.string(),
    error_description: z.string().optional(),
    interval: z.number().optional(),
  }),
]);

export type AccessTokenPollResult =
  | {
      status: "success";
      accessToken: string;
      refreshToken: string | null;
      expiresAt: number | null;
      refreshTokenExpiresAt: number | null;
    }
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

export async function pollForAccessToken(
  input: { clientId: string; deviceCode: string } & CredentialRequestOptions,
): Promise<AccessTokenPollResult> {
  const body = await credentialRequest(
    "https://github.com/login/oauth/access_token",
    {
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
    },
    input,
    async (response): Promise<unknown> => {
      if (!response.ok) {
        throw new DeviceFlowError(
          "network_error",
          `Access token request failed with status ${response.status}.`,
        );
      }
      return response.json();
    },
  ).catch(deviceFlowTimeout("Access token request"));
  const payload = accessTokenResponseSchema.safeParse(body);
  if (!payload.success) {
    throw new DeviceFlowError(
      "invalid_response",
      "Malformed access token response from GitHub.",
    );
  }

  if ("access_token" in payload.data) {
    const now = Date.now();
    return {
      status: "success",
      accessToken: payload.data.access_token,
      refreshToken: payload.data.refresh_token ?? null,
      expiresAt:
        typeof payload.data.expires_in === "number"
          ? now + payload.data.expires_in * 1000
          : null,
      refreshTokenExpiresAt:
        typeof payload.data.refresh_token_expires_in === "number"
          ? now + payload.data.refresh_token_expires_in * 1000
          : null,
    };
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

export type RefreshTokenErrorKind = "terminal" | "transient";

export class RefreshTokenError extends Error {
  constructor(
    public readonly kind: RefreshTokenErrorKind,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? `Refresh token error: ${code}`);
    this.name = "RefreshTokenError";
  }
}

const TERMINAL_REFRESH_ERRORS = new Set<string>([
  "bad_refresh_token",
  "unauthorized_client",
  "invalid_grant",
  "unsupported_grant_type",
]);

export type RefreshTokenResult = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  refreshTokenExpiresAt: number | null;
};

export async function refreshAccessToken(
  input: { clientId: string; refreshToken: string } & CredentialRequestOptions,
): Promise<RefreshTokenResult> {
  let exchange: { response: Response; json: unknown; readJsonError: unknown };
  try {
    exchange = await credentialRequest(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: input.clientId,
          grant_type: "refresh_token",
          refresh_token: input.refreshToken,
        }).toString(),
      },
      input,
      async (response) => {
        try {
          return { response, json: await response.json(), readJsonError: null };
        } catch (cause) {
          return { response, json: null, readJsonError: cause };
        }
      },
    );
  } catch (cause) {
    // A timeout or caller abort stays transient even when a 4xx status
    // arrived before the body stalled.
    throw new RefreshTokenError(
      "transient",
      cause instanceof CredentialTimeoutError ? "timeout" : "network_error",
      cause instanceof Error ? cause.message : undefined,
    );
  }
  const { response, json, readJsonError } = exchange;

  const parsed = accessTokenResponseSchema.safeParse(json);

  if (parsed.success && "access_token" in parsed.data) {
    if (!response.ok) {
      // Success envelope on a non-2xx response is unexpected; treat as transient.
      throw new RefreshTokenError(
        "transient",
        "invalid_response",
        `Refresh succeeded with status ${response.status} but the response was unexpected.`,
      );
    }
    const now = Date.now();
    return {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token ?? null,
      expiresAt:
        typeof parsed.data.expires_in === "number"
          ? now + parsed.data.expires_in * 1000
          : null,
      refreshTokenExpiresAt:
        typeof parsed.data.refresh_token_expires_in === "number"
          ? now + parsed.data.refresh_token_expires_in * 1000
          : null,
    };
  }

  if (parsed.success && "error" in parsed.data) {
    const code = parsed.data.error;
    const kind: RefreshTokenErrorKind = TERMINAL_REFRESH_ERRORS.has(code)
      ? "terminal"
      : "transient";
    throw new RefreshTokenError(kind, code, parsed.data.error_description);
  }

  if (!response.ok) {
    // HTTP 400/401 on refresh_token grant indicate bad client credentials or an
    // invalid/revoked refresh token per OAuth2 and GitHub App device-flow docs.
    const kind: RefreshTokenErrorKind =
      response.status === 400 || response.status === 401
        ? "terminal"
        : "transient";
    throw new RefreshTokenError(
      kind,
      "http_error",
      `Refresh request failed with status ${response.status}.`,
    );
  }

  throw new RefreshTokenError(
    "transient",
    "invalid_response",
    readJsonError instanceof Error
      ? readJsonError.message
      : "Malformed refresh-token response.",
  );
}

function createAuthHeaders(token: string): Headers {
  return new Headers({
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  });
}

type AuthPaginationTarget =
  { kind: "none" } | { kind: "valid"; url: string } | { kind: "invalid" };

type LinkHeaderEntry = {
  target: string;
  relations: string[];
};

function parseAuthPaginationTarget(
  header: string | null,
  expectedPathname: string,
): AuthPaginationTarget {
  if (header == null) {
    return { kind: "none" };
  }

  if (header.trim() === "") {
    return { kind: "none" };
  }

  const entries = parseLinkHeaderEntries(header);
  if (entries == null) {
    return { kind: "invalid" };
  }

  const nextEntries = entries.filter(({ relations }) =>
    relations.includes("next"),
  );
  if (nextEntries.length === 0) {
    return { kind: "none" };
  }
  if (nextEntries.length !== 1) {
    return { kind: "invalid" };
  }

  const url = nextEntries[0].target;
  return isExpectedAuthPaginationUrl(url, expectedPathname)
    ? { kind: "valid", url }
    : { kind: "invalid" };
}

function parseLinkHeaderEntries(header: string): LinkHeaderEntry[] | null {
  const segments: string[] = [];
  let segmentStart = 0;
  let insideTarget = false;
  let insideQuotedString = false;
  let escaped = false;

  for (let index = 0; index < header.length; index++) {
    const character = header[index];
    if (insideQuotedString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        insideQuotedString = false;
      }
      continue;
    }

    if (character === '"') {
      if (insideTarget) {
        return null;
      }
      insideQuotedString = true;
    } else if (character === "<") {
      if (insideTarget) {
        return null;
      }
      insideTarget = true;
    } else if (character === ">") {
      if (!insideTarget) {
        return null;
      }
      insideTarget = false;
    } else if (character === "," && !insideTarget) {
      segments.push(header.slice(segmentStart, index));
      segmentStart = index + 1;
    }
  }

  if (insideTarget || insideQuotedString || escaped) {
    return null;
  }
  segments.push(header.slice(segmentStart));

  const entries: LinkHeaderEntry[] = [];
  for (const segment of segments) {
    const entry = parseLinkHeaderEntry(segment);
    if (entry == null) {
      return null;
    }
    entries.push(entry);
  }
  return entries;
}

function parseLinkHeaderEntry(segment: string): LinkHeaderEntry | null {
  let index = skipOptionalWhitespace(segment, 0);
  if (segment[index] !== "<") {
    return null;
  }

  const targetEnd = segment.indexOf(">", index + 1);
  if (targetEnd === -1 || targetEnd === index + 1) {
    return null;
  }
  const target = segment.slice(index + 1, targetEnd);
  index = targetEnd + 1;

  const relations: string[] = [];
  while (true) {
    index = skipOptionalWhitespace(segment, index);
    if (index === segment.length) {
      return { target, relations };
    }
    if (segment[index] !== ";") {
      return null;
    }

    index = skipOptionalWhitespace(segment, index + 1);
    const nameStart = index;
    while (index < segment.length && isLinkTokenCharacter(segment[index])) {
      index += 1;
    }
    if (index === nameStart) {
      return null;
    }
    const name = segment.slice(nameStart, index).toLowerCase();

    index = skipOptionalWhitespace(segment, index);
    if (segment[index] !== "=") {
      return null;
    }
    index = skipOptionalWhitespace(segment, index + 1);

    const parsedValue = parseLinkParameterValue(segment, index);
    if (parsedValue == null) {
      return null;
    }
    index = parsedValue.end;

    if (name === "rel") {
      relations.push(...parsedValue.value.split(/\s+/).filter(Boolean));
    }
  }
}

function parseLinkParameterValue(
  segment: string,
  start: number,
): { value: string; end: number } | null {
  if (segment[start] !== '"') {
    let end = start;
    while (end < segment.length && isLinkTokenCharacter(segment[end])) {
      end += 1;
    }
    return end === start ? null : { value: segment.slice(start, end), end };
  }

  let value = "";
  for (let index = start + 1; index < segment.length; index++) {
    const character = segment[index];
    if (character === '"') {
      return { value, end: index + 1 };
    }
    if (character === "\\") {
      index += 1;
      if (index === segment.length) {
        return null;
      }
      value += segment[index];
    } else {
      value += character;
    }
  }
  return null;
}

function skipOptionalWhitespace(value: string, start: number): number {
  let index = start;
  while (value[index] === " " || value[index] === "\t") {
    index += 1;
  }
  return index;
}

function isLinkTokenCharacter(character: string | undefined): boolean {
  return character != null && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]$/.test(character);
}

function isExpectedAuthPaginationUrl(
  url: string,
  expectedPathname: string,
): boolean {
  const rawTarget =
    /^https:\/\/api\.github\.com(?::443)?(\/[^?#]*)(?:\?[^#]*)?$/i.exec(url);
  if (rawTarget?.[1] !== expectedPathname) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return (
      parsed.origin === "https://api.github.com" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === expectedPathname &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

const githubUserSchema = z.object({
  login: z.string(),
  avatar_url: z.string().url().nullable().optional(),
});

export type AuthenticatedUser = {
  login: string;
  avatarUrl: string | null;
};

export async function fetchAuthenticatedUser(
  input: { token: string } & CredentialRequestOptions,
): Promise<AuthenticatedUser> {
  const body = await credentialRequest(
    "https://api.github.com/user",
    { headers: createAuthHeaders(input.token) },
    input,
    async (response): Promise<unknown> => {
      if (!response.ok) {
        throw new Error(`GET /user failed with status ${response.status}.`);
      }
      return response.json();
    },
  );
  const parsed = githubUserSchema.safeParse(body);
  if (!parsed.success) {
    throw new GitHubAuthSchemaError("GET /user", parsed.error.issues);
  }
  return {
    login: parsed.data.login,
    avatarUrl: parsed.data.avatar_url ?? null,
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

export type PaginatedResult<T> = {
  items: T[];
  truncated: boolean;
};

export const MAX_INSTALLATION_PAGES = 10;

// Each page gets its own credential request bound.
function fetchInstallationPage(
  url: string,
  endpoint: string,
  input: { token: string } & CredentialRequestOptions,
): Promise<{ body: unknown; link: string | null }> {
  return credentialRequest(
    url,
    { headers: createAuthHeaders(input.token) },
    input,
    async (response) => {
      if (!response.ok) {
        throw new Error(
          `GET ${endpoint} failed with status ${response.status}.`,
        );
      }
      return {
        body: (await response.json()) as unknown,
        link: response.headers.get("link"),
      };
    },
  );
}

export async function fetchUserInstallations(
  input: { token: string } & CredentialRequestOptions,
): Promise<PaginatedResult<ApiInstallation>> {
  const results: ApiInstallation[] = [];
  const expectedPathname = "/user/installations";
  let truncated = false;
  let url: string | null =
    "https://api.github.com/user/installations?per_page=100";
  for (let page = 0; page < MAX_INSTALLATION_PAGES && url != null; page++) {
    const response = await fetchInstallationPage(
      url,
      "/user/installations",
      input,
    );
    const parsed = userInstallationsSchema.safeParse(response.body);
    if (!parsed.success) {
      throw new GitHubAuthSchemaError(
        "GET /user/installations",
        parsed.error.issues,
      );
    }
    for (const installation of parsed.data.installations) {
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
    const nextTarget = parseAuthPaginationTarget(
      response.link,
      expectedPathname,
    );
    if (nextTarget.kind === "valid") {
      url = nextTarget.url;
    } else {
      truncated = nextTarget.kind === "invalid";
      url = null;
    }
  }
  return { items: results, truncated: truncated || url != null };
}

const installationRepositoriesSchema = z.object({
  total_count: z.number(),
  repositories: z.array(z.object({ full_name: z.string() })),
});

export async function fetchInstallationRepositories(
  input: { token: string; installationId: number } & CredentialRequestOptions,
): Promise<PaginatedResult<string>> {
  const results: string[] = [];
  const expectedPathname = `/user/installations/${input.installationId}/repositories`;
  let truncated = false;
  let url: string | null =
    `https://api.github.com${expectedPathname}?per_page=100`;
  for (let page = 0; page < MAX_INSTALLATION_PAGES && url != null; page++) {
    const response = await fetchInstallationPage(url, expectedPathname, input);
    const parsed = installationRepositoriesSchema.safeParse(response.body);
    if (!parsed.success) {
      throw new GitHubAuthSchemaError(
        `GET /user/installations/${input.installationId}/repositories`,
        parsed.error.issues,
      );
    }
    for (const repository of parsed.data.repositories) {
      results.push(repository.full_name);
    }
    const nextTarget = parseAuthPaginationTarget(
      response.link,
      expectedPathname,
    );
    if (nextTarget.kind === "valid") {
      url = nextTarget.url;
    } else {
      truncated = nextTarget.kind === "invalid";
      url = null;
    }
  }
  return { items: results, truncated: truncated || url != null };
}
