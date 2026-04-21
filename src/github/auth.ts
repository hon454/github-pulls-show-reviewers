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
