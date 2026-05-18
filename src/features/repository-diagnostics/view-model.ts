import type {
  GitHubRateLimitSnapshot,
  RepositoryValidationOutcome,
  RepositoryValidationResult,
} from "../../github/api";
import type { AccountCoverageResolution, Account } from "../../storage/accounts";

export type RepositoryDiagnosticTone =
  | "neutral"
  | "success"
  | "warning"
  | "error";

export type RepositoryDiagnosticField = {
  label: string;
  value: string;
  tone: RepositoryDiagnosticTone;
};

export type RepositoryDiagnosticViewModel = {
  tone: Extract<RepositoryDiagnosticTone, "neutral" | "success" | "error">;
  message: string;
  fields: RepositoryDiagnosticField[];
};

type MatchedAccountCoverageStatus = Exclude<
  AccountCoverageResolution["status"],
  "uncovered"
>;

export function buildMatchedAccountDiagnostic(input: {
  repository: string;
  coverageStatus: MatchedAccountCoverageStatus;
  account: Account;
  result: RepositoryValidationResult;
}): RepositoryDiagnosticViewModel {
  const fields: RepositoryDiagnosticField[] = [
    field("Repository", input.result.fullName ?? input.repository),
    field("Matched account", `@${input.account.login}`, "success"),
    field("Auth mode", "Matched account token", "success"),
    coverageField(input.coverageStatus),
    endpointResultField(input.result),
    ...rateLimitFields(input.result.rateLimit),
  ];

  return {
    tone: input.result.ok ? "success" : "error",
    message: input.result.message,
    fields,
  };
}

export function buildNoTokenDiagnostic(input: {
  repository: string;
  result: RepositoryValidationResult;
}): RepositoryDiagnosticViewModel {
  return {
    tone: input.result.ok ? "success" : "error",
    message: input.result.message,
    fields: [
      field("Repository", input.result.fullName ?? input.repository),
      field("Matched account", "Not checked"),
      field("Auth mode", "No token"),
      field("Installation coverage", "Not checked"),
      endpointResultField(input.result),
      ...rateLimitFields(input.result.rateLimit),
    ],
  };
}

export function buildUncoveredAccountDiagnostic(
  repository: string,
  message: string,
): RepositoryDiagnosticViewModel {
  return {
    tone: "error",
    message,
    fields: [
      field("Repository", repository),
      field("Matched account", "None", "error"),
      field("Auth mode", "Matched account token", "error"),
      field("Installation coverage", "Uncovered", "error"),
      field("Endpoint result", "Not checked"),
    ],
  };
}

function field(
  label: string,
  value: string,
  tone: RepositoryDiagnosticTone = "neutral",
): RepositoryDiagnosticField {
  return { label, value, tone };
}

function coverageField(
  status: MatchedAccountCoverageStatus,
): RepositoryDiagnosticField {
  if (status === "covered") {
    return field("Installation coverage", "Covered", "success");
  }

  return field(
    "Installation coverage",
    "Maybe covered; installation repository snapshot is incomplete",
    "warning",
  );
}

function endpointResultField(
  result: RepositoryValidationResult,
): RepositoryDiagnosticField {
  const httpStatus = result.httpStatus ? ` (HTTP ${result.httpStatus})` : "";

  return field(
    "Endpoint result",
    `${endpointOutcomeLabel(result.outcome)}${httpStatus}`,
    endpointOutcomeTone(result.outcome),
  );
}

function endpointOutcomeLabel(outcome: RepositoryValidationOutcome): string {
  switch (outcome) {
    case "accessible":
      return "Accessible";
    case "invalid-repository":
      return "Invalid repository";
    case "no-pulls":
      return "No pull requests found";
    case "unauthenticated-rate-limit":
      return "Unauthenticated rate limit";
    case "unauthenticated-private-like":
      return "Sign-in required for reviewer access";
    case "token-invalid":
      return "Token expired";
    case "token-permission":
      return "GitHub App installation missing";
    case "token-not-found":
      return "Repository not covered by GitHub App";
    case "unknown-error":
      return "Unknown error";
  }
}

function endpointOutcomeTone(
  outcome: RepositoryValidationOutcome,
): RepositoryDiagnosticTone {
  if (outcome === "accessible") {
    return "success";
  }

  if (outcome === "no-pulls" || outcome === "invalid-repository") {
    return "warning";
  }

  return "error";
}

function rateLimitFields(
  rateLimit: GitHubRateLimitSnapshot | undefined,
): RepositoryDiagnosticField[] {
  if (!rateLimit) {
    return [];
  }

  const segments: string[] = [];

  if (rateLimit.remaining !== null && rateLimit.limit !== null) {
    segments.push(`${rateLimit.remaining} of ${rateLimit.limit} remaining`);
  }

  if (rateLimit.resource) {
    segments.push(`resource ${rateLimit.resource}`);
  }

  if (rateLimit.resetAt !== null) {
    segments.push(`resets at ${formatResetAt(rateLimit.resetAt)}`);
  }

  if (segments.length === 0) {
    return [];
  }

  return [field("Rate limit", segments.join(", "), "error")];
}

function formatResetAt(resetAt: number): string {
  return new Date(resetAt * 1000)
    .toISOString()
    .replace(/T(\d{2}:\d{2}):\d{2}\.\d{3}Z$/, " $1 UTC");
}
