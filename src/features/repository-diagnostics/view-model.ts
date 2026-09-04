import type {
  GitHubRateLimitSnapshot,
  RepositoryValidationEndpointFailure,
  RepositoryValidationOutcome,
  RepositoryValidationResult,
} from "../../github/api";
import { createTranslator, type Translator } from "../../i18n";
import type {
  AccountCoverageResolution,
  Account,
} from "../../storage/accounts";

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
  tone: Exclude<RepositoryDiagnosticTone, "warning">;
  message: string;
  fields: RepositoryDiagnosticField[];
};
type MatchedAccountInput = {
  repository: string;
  coverageStatus: Exclude<AccountCoverageResolution["status"], "uncovered">;
  account: Pick<Account, "login">;
  result: RepositoryValidationResult;
};
type NoTokenInput = { repository: string; result: RepositoryValidationResult };

/** Store data, never translated strings or account credentials, across locale changes. */
export type RepositoryDiagnosticState =
  | { kind: "empty" | "running" | "input-matched" | "input-no-token" }
  | { kind: "failed"; failures: RepositoryValidationEndpointFailure[] }
  | { kind: "uncovered"; repository: string }
  | ({ kind: "matched" } & MatchedAccountInput)
  | ({ kind: "no-token" } & NoTokenInput);

const english = createTranslator("en");

export function buildRepositoryDiagnostic(
  state: RepositoryDiagnosticState,
  t: Translator,
): RepositoryDiagnosticViewModel {
  switch (state.kind) {
    case "matched":
      return buildMatchedAccountDiagnostic(state, t);
    case "no-token":
      return buildNoTokenDiagnostic(state, t);
    case "uncovered":
      return buildUncoveredAccountDiagnostic(state.repository, t);
    case "failed":
      return {
        tone: "error",
        message: t("diagnostics_run_failed"),
        fields: failureFields(state.failures, t),
      };
    case "empty":
      return { tone: "neutral", message: t("diagnostics_empty"), fields: [] };
    case "running":
      return { tone: "neutral", message: t("diagnostics_running"), fields: [] };
    case "input-matched":
      return {
        tone: "error",
        message: t("diagnostics_input_matched"),
        fields: [],
      };
    case "input-no-token":
      return {
        tone: "error",
        message: t("diagnostics_input_no_token"),
        fields: [],
      };
  }
}

export function buildMatchedAccountDiagnostic(
  input: MatchedAccountInput,
  t: Translator = english,
): RepositoryDiagnosticViewModel {
  return {
    tone: input.result.ok ? "success" : "error",
    message: resultMessage(input.result, input.repository, t),
    fields: [
      field(
        t("diagnostics_repository"),
        input.result.fullName ?? input.repository,
      ),
      field(
        t("diagnostics_matched_account"),
        `@${input.account.login}`,
        "success",
      ),
      field(
        t("diagnostics_auth_mode"),
        t("diagnostics_matched_token"),
        "success",
      ),
      field(
        t("diagnostics_coverage"),
        t(
          input.coverageStatus === "covered"
            ? "diagnostics_covered"
            : "diagnostics_truncated",
        ),
        input.coverageStatus === "covered" ? "success" : "warning",
      ),
      ...resultFields(input.result, t),
    ],
  };
}

export function buildNoTokenDiagnostic(
  input: NoTokenInput,
  t: Translator = english,
): RepositoryDiagnosticViewModel {
  return {
    tone: input.result.ok ? "success" : "error",
    message: resultMessage(input.result, input.repository, t),
    fields: [
      field(
        t("diagnostics_repository"),
        input.result.fullName ?? input.repository,
      ),
      field(t("diagnostics_matched_account"), t("diagnostics_not_checked")),
      field(t("diagnostics_auth_mode"), t("diagnostics_no_token")),
      field(t("diagnostics_coverage"), t("diagnostics_not_checked")),
      ...resultFields(input.result, t),
    ],
  };
}

export function buildUncoveredAccountDiagnostic(
  repository: string,
  t: Translator = english,
): RepositoryDiagnosticViewModel {
  return {
    tone: "error",
    message: t("diagnostics_uncovered", { repository }),
    fields: [
      field(t("diagnostics_repository"), repository),
      field(t("diagnostics_matched_account"), t("diagnostics_none"), "error"),
      field(t("diagnostics_auth_mode"), t("diagnostics_not_checked")),
      field(
        t("diagnostics_coverage"),
        t("diagnostics_uncovered_label"),
        "error",
      ),
      field(t("diagnostics_endpoint_result"), t("diagnostics_not_checked")),
    ],
  };
}

const outcomeLabels = {
  accessible: "diagnostics_accessible_label",
  "invalid-repository": "diagnostics_invalid_label",
  "no-pulls": "diagnostics_no_pulls_label",
  "authenticated-rate-limit": "diagnostics_token_rate_label",
  "unauthenticated-rate-limit": "diagnostics_no_token_rate_label",
  "unauthenticated-private-like": "diagnostics_private_like_label",
  "token-invalid": "diagnostics_token_invalid_label",
  "token-permission": "diagnostics_permission_label",
  "token-not-found": "diagnostics_not_found_label",
  "unknown-error": "diagnostics_unknown_label",
} as const satisfies Record<RepositoryValidationOutcome, string>;

function resultMessage(
  result: RepositoryValidationResult,
  fallback: string,
  t: Translator,
): string {
  const repository = result.fullName ?? fallback;
  switch (result.outcome) {
    case "accessible":
      return t(
        result.authMode === "token"
          ? "diagnostics_accessible_token"
          : "diagnostics_accessible_no_token",
        {
          repository,
          pull: result.pullNumber,
          endpoints: `GET /repos/${repository}/pulls/${result.pullNumber}, GET /repos/${repository}/pulls/${result.pullNumber}/reviews`,
        },
      );
    case "invalid-repository":
      return t("diagnostics_invalid");
    case "no-pulls":
      return t("diagnostics_no_pulls", { repository });
    case "authenticated-rate-limit":
      return t("diagnostics_token_rate", { repository });
    case "unauthenticated-rate-limit":
      return t("diagnostics_no_token_rate", { repository });
    case "unauthenticated-private-like":
      return t("diagnostics_private_like", { repository });
    case "token-invalid":
      return t("diagnostics_token_invalid", { repository });
    case "token-permission":
      return t("diagnostics_permission", { repository });
    case "token-not-found":
      return t("diagnostics_not_found", { repository });
    case "unknown-error":
      return t("diagnostics_unknown", { repository });
  }
}

function resultFields(
  result: RepositoryValidationResult,
  t: Translator,
): RepositoryDiagnosticField[] {
  const fields = [
    field(
      t("diagnostics_endpoint_result"),
      t(outcomeLabels[result.outcome]),
      result.ok
        ? "success"
        : result.outcome === "no-pulls" ||
            result.outcome === "invalid-repository"
          ? "warning"
          : "error",
    ),
  ];
  if (result.pullNumber != null)
    fields.push(field(t("diagnostics_pull_number"), `#${result.pullNumber}`));
  // Legacy primary evidence is retained for older producers; new results preserve every failure.
  if (result.failures?.length)
    fields.push(...failureFields(result.failures, t));
  else {
    if (!result.ok && result.httpStatus != null)
      fields.push(
        ...failureFields(
          [
            {
              kind: "http",
              httpStatus: result.httpStatus,
              ...(result.endpoint ? { endpoint: result.endpoint } : {}),
            },
          ],
          t,
        ),
      );
    fields.push(...rateLimitFields(result.rateLimit, t));
  }
  return fields;
}

function failureFields(
  failures: RepositoryValidationEndpointFailure[],
  t: Translator,
): RepositoryDiagnosticField[] {
  return failures.flatMap((failure) => {
    const endpoint = failure.endpoint
      ? `${failure.endpoint.method} ${failure.endpoint.path}`
      : t("diagnostics_api_request");
    let message: string;
    switch (failure.kind) {
      case "http":
        message =
          failure.httpStatus == null
            ? t("diagnostics_unknown_failure", { endpoint })
            : t("diagnostics_http_failure", {
                endpoint,
                status: failure.httpStatus,
              });
        break;
      case "schema":
        message = t("diagnostics_schema_failure", { endpoint });
        break;
      case "network":
        message = t("diagnostics_network_failure", { endpoint });
        break;
      case "unknown":
        message = t("diagnostics_unknown_failure", { endpoint });
        break;
    }
    return [
      field(t("diagnostics_endpoint_failure"), message, "error"),
      ...rateLimitFields(failure.rateLimit, t),
    ];
  });
}

function rateLimitFields(
  rate: GitHubRateLimitSnapshot | undefined,
  t: Translator,
): RepositoryDiagnosticField[] {
  if (!rate) return [];
  const fields: RepositoryDiagnosticField[] = [];
  const tone = rate.remaining === 0 ? "error" : "neutral";
  if (rate.remaining != null && rate.limit != null)
    fields.push(
      field(
        t("diagnostics_rate_limit"),
        t("diagnostics_rate_quota", {
          remaining: rate.remaining,
          limit: rate.limit,
        }),
        tone,
      ),
    );
  else {
    if (rate.remaining != null)
      fields.push(
        field(t("diagnostics_rate_remaining"), String(rate.remaining), tone),
      );
    if (rate.limit != null)
      fields.push(field(t("diagnostics_rate_total"), String(rate.limit), tone));
  }
  if (rate.resource)
    fields.push(field(t("diagnostics_rate_resource"), rate.resource, tone));
  if (rate.resetAt != null)
    fields.push(
      field(t("diagnostics_rate_reset"), formatResetAt(rate.resetAt), tone),
    );
  return fields;
}

function field(
  label: string,
  value: string,
  tone: RepositoryDiagnosticTone = "neutral",
): RepositoryDiagnosticField {
  return { label, value, tone };
}

function formatResetAt(resetAt: number): string {
  return new Date(resetAt * 1000)
    .toISOString()
    .replace(/T(\d{2}:\d{2}):\d{2}\.\d{3}Z$/, " $1 UTC");
}
