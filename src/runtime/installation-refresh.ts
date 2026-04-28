import type { InstallationRefreshOutcome } from "../background/installation-refresh";

export type RefreshAccountInstallationsMessage = {
  type: "refreshAccountInstallations";
  accountId: string;
};

export type RefreshAccountInstallationsResponse =
  | InstallationRefreshOutcome
  | undefined;

export function isRefreshAccountInstallationsMessage(
  value: unknown,
): value is RefreshAccountInstallationsMessage {
  return (
    value != null &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "refreshAccountInstallations" &&
    typeof (value as { accountId?: unknown }).accountId === "string" &&
    ((value as { accountId: string }).accountId.trim().length > 0)
  );
}
