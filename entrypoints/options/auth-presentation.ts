import type { MessageKey } from "../../src/i18n";

type AuthErrorKey = Extract<
  MessageKey,
  `auth_error_${string}` | "auth_expired" | "auth_denied"
>;
const errorKeys: Record<string, AuthErrorKey> = {
  expired_token: "auth_expired",
  access_denied: "auth_denied",
  device_flow_disabled: "auth_error_disabled",
  unsupported_grant_type: "auth_error_grant",
  incorrect_client_credentials: "auth_error_client",
  incorrect_device_code: "auth_error_device_code",
  network_error: "auth_error_network",
  invalid_response: "auth_error_invalid_response",
};
export function authErrorKey(code: string): AuthErrorKey {
  return Object.hasOwn(errorKeys, code)
    ? errorKeys[code]
    : "auth_error_unknown";
}
